#!/usr/bin/env node
// Election night tracker. Polls RNZ's 2026 results pages (Electoral Commission data) and serves a
// dashboard. One poller is shared by every viewer.
//
// Each cycle:
//   - the results overview page every 30 s (party votes, seats, electorate/list split, % counted)
//   - the all-electorates page every 30 s (leader, party, margin, % counted for all 71 seats)
//   - individual electorate pages only for close seats, a few every 10 s (runner-up and full
//     candidate votes)
//
// Node 18+ and no dependencies.
//   node server.mjs
//   node server.mjs --dump        (save every fetched page to ./dump for debugging the parser)
//
// Every flag can also be set as an env var (handy on Railway):
//   --base           BASE_URL        default https://www.rnz.co.nz/news/election-2026-results
//   --port           PORT            default 8026
//   --every          EVERY           seconds between overview + electorates polls, default 30
//   --tick           TICK            seconds between close-seat batches, default 10
//   --batch          BATCH           close-seat pages per batch, default 3
//   --watch-margin   WATCH_MARGIN    seats under this margin get full candidate detail, default 2000
//   --ua             USER_AGENT

import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const opt = (flag, env, fallback) => args[flag] ?? process.env[env] ?? fallback;
const BASE = String(opt('base', 'BASE_URL', 'https://www.rnz.co.nz/news/election-2026-results')).replace(/\/+$/, '');
const LIST_URL = `${BASE}/electorates`;
const PORT = Number(opt('port', 'PORT', 8026));
const EVERY = Number(opt('every', 'EVERY', 30)) * 1000;
const TICK = Number(opt('tick', 'TICK', 10)) * 1000;
const BATCH = Number(opt('batch', 'BATCH', 3));
const WATCH_MARGIN = Number(opt('watch-margin', 'WATCH_MARGIN', 2000));
const UA = opt('ua', 'USER_AGENT', 'election-results-26/1.0 (+https://github.com/edmofro/election-results-26; one shared poller)');
const DUMP = args.dump ? path.resolve(args.dump === true ? 'dump' : args.dump) : null;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const state = {
  source: BASE,
  startedAt: new Date().toISOString(),
  overall: null,
  electorates: new Map(), // slug -> { slug, url, list, detail, history }
  listFetchedAt: null,
  blocked: null,
  errors: [],
};

// ---------- fetching ----------

const cache = new Map(); // url -> { etag, lastModified, body }

class FetchError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function fetchPage(url) {
  const prev = cache.get(url);
  const headers = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' };
  if (prev?.etag) headers['if-none-match'] = prev.etag;
  if (prev?.lastModified) headers['if-modified-since'] = prev.lastModified;

  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (res.status === 304 && prev) return prev.body;
  const body = await res.text();

  if (res.status === 403 || res.status === 429 || (res.status === 503 && !/<table/i.test(body))) {
    state.blocked = { status: res.status, url, at: new Date().toISOString() };
    throw new FetchError(`HTTP ${res.status}: the site refused the request (rate limit or bot protection)`, res.status);
  }
  if (!res.ok) throw new FetchError(`HTTP ${res.status}`, res.status);
  if (/captcha|cf-challenge|are you a robot|access denied/i.test(body) && !/<table/i.test(body)) {
    state.blocked = { status: res.status, url, at: new Date().toISOString() };
    throw new FetchError('Got a bot-protection page instead of results', res.status);
  }

  state.blocked = null;
  cache.set(url, { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), body });
  if (DUMP) {
    await mkdir(DUMP, { recursive: true });
    await writeFile(path.join(DUMP, url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_') + '.html'), body);
  }
  return body;
}

function logError(url, err) {
  state.errors.unshift({ at: new Date().toISOString(), url, message: String(err.message || err) });
  state.errors.length = Math.min(state.errors.length, 20);
  console.warn(`[${new Date().toLocaleTimeString()}] ${url}: ${err.message || err}`);
}

// ---------- HTML helpers (regex-based, no deps) ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e] ?? m;
});
const stripScripts = (html) => html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
const toText = (html) => decode(stripScripts(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const rowsOf = (tableHtml) => [...tableHtml.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((r) => r[0]);
const cellsOf = (rowHtml) => [...rowHtml.matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((c) => c[2]);
const tables = (html) => [...stripScripts(html).matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((t) => t[0]);
const num = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const STATUS_WORD = /\s+(lead|leads|wins?|won|holds?|retains?|gains?)$/i;

// ---------- parsers (RNZ election-2026-results markup) ----------

// Overview: "Results by party" table [Party, Votes, Pct., Seats] plus the screen-reader seat
// breakdown "<p><span>Labour</span>: 20 electorate seats, 16 list seats, 36 total seats</p>".
function parseOverview(html) {
  const parties = [];
  let totals = null;
  for (const t of tables(html)) {
    const rows = rowsOf(t);
    const head = toText(rows[0] || '');
    if (!/party/i.test(head) || !/votes/i.test(head) || !/seats/i.test(head)) continue;
    for (const r of rows.slice(1)) {
      const [name, votes, pct, seats] = cellsOf(r).map(toText);
      if (!name) continue;
      if (/^total$/i.test(name)) { totals = { votes: num(votes), seats: num(seats) }; continue; }
      parties.push({ name, votes: num(votes), pct: num(pct), seats: num(seats) || 0, electorate: 0, list: num(seats) || 0 });
    }
    if (parties.length) break;
  }

  const split = new Map();
  const re = /<p>\s*<span[^>]*>([^<]+)<\/span>\s*:\s*(\d+)\s+electorate seats?,\s*(\d+)\s+list seats?,\s*(\d+)\s+total seats?\s*<\/p>/gi;
  for (const m of html.matchAll(re)) split.set(decode(m[1]).trim(), { electorate: +m[2], list: +m[3], seats: +m[4] });
  for (const p of parties) {
    const s = split.get(p.name);
    if (s) Object.assign(p, { electorate: s.electorate, list: s.list, seats: s.seats });
  }

  const text = toText(html);
  const counted = text.match(/([\d.]+)\s*%\s*counted/i);
  return {
    parties,
    totals,
    countedPct: counted ? Number(counted[1]) : null,
    // RNZ's disclaimer mentions "official" results too, so only call it official once "preliminary" is gone
    stage: !/preliminary/i.test(text) && /official/i.test(text) ? 'official' : 'preliminary',
    fetchedAt: new Date().toISOString(),
  };
}

// All-electorates page: one row per seat linking to /electorate/<slug>, with "% counted",
// "<Party> lead" / "<Leader name>", and the margin. The page also has a "Key electorates" table
// repeating some seats, so rows are keyed by slug.
function parseElectorateList(html, baseUrl) {
  const out = new Map();
  for (const t of tables(html)) {
    for (const r of rowsOf(t)) {
      const link = r.match(/href="([^"]*\/electorate\/([^"/?#]+))"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      const cells = cellsOf(r);
      const slug = link[2];
      const counted = toText(cells[0] || '').match(/([\d.]+)\s*%\s*counted/i);
      const status = (cells[1] || '').match(/<div[^>]*class="[^"]*\btext-sm\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*\btext-xs\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const party = status ? toText(status[1]).replace(STATUS_WORD, '').trim() : null;
      const leaderName = status ? toText(status[2]) : null;
      out.set(slug, {
        slug,
        url: new URL(decode(link[1]), baseUrl).href,
        name: toText(link[3]),
        countedPct: counted ? Number(counted[1]) : null,
        leader: leaderName ? { name: leaderName, party } : null,
        margin: num(toText(cells[2] || '')),
        fetchedAt: new Date().toISOString(),
      });
    }
  }
  return out;
}

// Electorate page: <h1>Name</h1>, "% counted", and a Candidates table [Candidate, Party, Pct., Votes].
function parseElectorate(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const text = toText(html);
  const counted = text.match(/([\d.]+)\s*%\s*counted/i);
  let candidates = [];
  for (const t of tables(html)) {
    const rows = rowsOf(t);
    if (!/candidate/i.test(toText(rows[0] || ''))) continue;
    for (const r of rows.slice(1)) {
      const cells = cellsOf(r).map(toText);
      if (!cells[0] || /^total$/i.test(cells[0])) continue;
      candidates.push({ name: cells[0], party: cells[1] || 'Independent', votes: num(cells.at(-1)) });
    }
    if (candidates.length) break;
  }
  candidates = candidates.filter((c) => c.votes != null).sort((a, b) => b.votes - a.votes);
  return {
    name: h1 ? toText(h1[1]) : null,
    countedPct: counted ? Number(counted[1]) : null,
    candidates,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- state ----------

// What the dashboard shows for a seat. The detail page is one consistent snapshot (leader, runner-up,
// votes, margin), so show it while it's reasonably fresh, even if the list page has refreshed since.
// Fall back to the list row (leader and margin only) when there's no detail yet, the detail is stale,
// or a newer list row shows a different leader (a lead change shouldn't wait for the next detail fetch).
const DETAIL_MAX_AGE = 5 * 60 * 1000;
const leadMismatch = (e) => e.detail && e.list?.leader && e.detail.candidates[0]?.name !== e.list.leader.name;
function view(e) {
  const l = e.list; const d = e.detail;
  const fresh = d && d.candidates.length >= 2 && Date.now() - Date.parse(d.fetchedAt) < DETAIL_MAX_AGE;
  const useDetail = fresh && (!l || !leadMismatch(e) || d.fetchedAt >= l.fetchedAt);
  const base = { slug: e.slug, url: e.url, name: d?.name || l?.name || e.slug, history: e.history };
  if (useDetail) {
    const [leader, runnerUp] = d.candidates;
    return { ...base, countedPct: d.countedPct ?? l?.countedPct, leader, runnerUp, margin: leader.votes - runnerUp.votes, candidates: d.candidates, fetchedAt: d.fetchedAt, detailed: true };
  }
  return { ...base, countedPct: l?.countedPct ?? null, leader: l?.leader || null, runnerUp: null, margin: l?.margin ?? null, candidates: [], fetchedAt: l?.fetchedAt, detailed: false };
}

function record(e) {
  const v = view(e);
  if (v.margin == null || !v.leader) return;
  const last = e.history.at(-1);
  if (!last || last.margin !== v.margin || last.leader !== v.leader.name) {
    e.history.push({ at: v.fetchedAt, margin: v.margin, leader: v.leader.name, countedPct: v.countedPct });
    if (e.history.length > 40) e.history.shift();
  }
}

async function pollPages() {
  try {
    try {
      const overall = parseOverview(await fetchPage(BASE));
      if (!overall.parties.length) throw new Error('No party table found on the RNZ results page (layout may have changed; run with --dump)');
      state.overall = overall;
    } catch (e) { logError(BASE, e); }

    try {
      const rows = parseElectorateList(await fetchPage(LIST_URL), LIST_URL);
      if (!rows.size) throw new Error('No electorates found on the RNZ electorates page (layout may have changed; run with --dump)');
      for (const [slug, row] of rows) {
        const e = state.electorates.get(slug) || { slug, url: row.url, list: null, detail: null, history: [] };
        e.list = row;
        e.url = row.url;
        state.electorates.set(slug, e);
        record(e);
      }
      state.listFetchedAt = new Date().toISOString();
    } catch (e) { logError(LIST_URL, e); }
  } finally {
    setTimeout(pollPages, EVERY);
  }
}

// Close seats only. Tighter seats and staler snapshots go first.
async function pollCloseSeats() {
  try {
    const now = Date.now();
    const due = [...state.electorates.values()]
      .filter((e) => (e.list?.margin ?? Infinity) < WATCH_MARGIN || (e.detail && view(e).margin < WATCH_MARGIN))
      .map((e) => {
        const age = e.triedAt ? now - e.triedAt : 1e12; // never-tried first; failures wait their turn too
        const m = view(e).margin ?? WATCH_MARGIN;
        return { e, score: leadMismatch(e) ? 1e13 : age * (m < 1000 ? 2 : 1) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, BATCH);
    await Promise.all(due.map(async ({ e }) => {
      e.triedAt = Date.now();
      try {
        const d = parseElectorate(await fetchPage(e.url));
        if (d.candidates.length) { e.detail = d; record(e); }
      } catch (err) { logError(e.url, err); }
    }));
  } finally {
    setTimeout(pollCloseSeats, TICK);
  }
}

// ---------- server ----------

function snapshot() {
  return {
    source: state.source,
    sourceName: 'RNZ',
    startedAt: state.startedAt,
    now: new Date().toISOString(),
    overall: state.overall,
    listFetchedAt: state.listFetchedAt,
    electorates: [...state.electorates.values()].map(view),
    watchMargin: WATCH_MARGIN,
    blocked: state.blocked,
    errors: state.errors.slice(0, 8),
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (req.url.startsWith('/api/state')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(snapshot()));
  }
  if (req.url === '/' || req.url.startsWith('/index.html') || req.url.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(await readFile(path.join(HERE, 'index.html')));
  }
  res.writeHead(404).end('Not found');
});

server.listen(PORT, () => {
  console.log(`Polling ${BASE}`);
  console.log(`Dashboard on port ${PORT}`);
  pollPages();
  setTimeout(pollCloseSeats, 4000);
});

// Node as PID 1 in a container ignores SIGTERM unless handled, which stalls redeploys.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// ---------- misc ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}
