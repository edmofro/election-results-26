#!/usr/bin/env node
// Election night tracker. Polls the Electoral Commission's preliminary results
// (electionresults.govt.nz) and serves a dashboard. One poller is shared by every viewer.
//
// Node 18+ and no dependencies.
//   node server.mjs
//   node server.mjs --base https://archive.electionresults.govt.nz/electionresults_2023/   (dry run on 2023)
//   node server.mjs --dump               (save every fetched page to ./dump for debugging the parser)
//
// Every flag can also be set as an env var (handy on Railway):
//   --base           BASE_URL        default https://electionresults.govt.nz/ge2026/
//   --port           PORT            default 8026
//   --overall-every  OVERALL_EVERY   seconds between party-vote polls, default 30
//   --tick           TICK            seconds between electorate batches, default 10
//   --batch          BATCH           electorate pages per batch, default 4
//   --watch-margin   WATCH_MARGIN    seats under this margin are polled ~4x as often, default 2000
//   --ua             USER_AGENT

import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const opt = (flag, env, fallback) => args[flag] ?? process.env[env] ?? fallback;
const BASE = withSlash(opt('base', 'BASE_URL', 'https://electionresults.govt.nz/ge2026/'));
const PORT = Number(opt('port', 'PORT', 8026));
const OVERALL_EVERY = Number(opt('overall-every', 'OVERALL_EVERY', 30)) * 1000;
const TICK = Number(opt('tick', 'TICK', 10)) * 1000;
const BATCH = Number(opt('batch', 'BATCH', 4));
const WATCH_MARGIN = Number(opt('watch-margin', 'WATCH_MARGIN', 2000));
const UA = opt('ua', 'USER_AGENT', 'nz-election-live/1.0 (results dashboard; one shared poller, polls politely)');
const DUMP = args.dump ? path.resolve(args.dump === true ? 'dump' : args.dump) : null;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const state = {
  source: BASE,
  startedAt: new Date().toISOString(),
  overall: null,
  electorates: new Map(), // url -> electorate record
  discovery: { status: 'pending', how: null, at: null },
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

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…',
  amacr: 'ā', Amacr: 'Ā', emacr: 'ē', Emacr: 'Ē', imacr: 'ī', Imacr: 'Ī',
  omacr: 'ō', Omacr: 'Ō', umacr: 'ū', Umacr: 'Ū',
};
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e] ?? m;
});
const toText = (html) => decode(
  html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
).replace(/\s+/g, ' ').trim();

function tables(html) {
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((t) =>
    [...t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((r) =>
      [...r[0].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((c) => toText(c[2]))));
}

function links(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try { out.add(new URL(decode(m[1]), base).href); } catch { /* ignore bad hrefs */ }
  }
  return [...out];
}

const num = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// ---------- parsers ----------

// Nationwide party table. Matches the 2023 and 2026 EC layouts:
// [party name, party votes, % of votes, electorate seats, list seats, total seats], "-" meaning zero.
function parseOverall(html) {
  const text = toText(html);
  let parties = [];
  let totals = null;

  for (const rows of tables(html)) {
    if (!rows.some((r) => r.some((c) => /party votes/i.test(c)))) continue;
    for (const r of rows) {
      if (r.length < 5 || /party votes/i.test(r.join(' '))) continue;
      const [name, ...rest] = r;
      const vals = rest.map((c) => (c.trim() === '-' || c.trim() === '' ? 0 : num(c)));
      if (/^total/i.test(name)) {
        totals = { votes: vals[0], electorate: vals.at(-3), list: vals.at(-2), seats: vals.at(-1) };
        continue;
      }
      if (!name || rest[0].trim() === '-' || vals[0] == null) continue; // component parties listed with no votes
      const [votes, pct, electorate, list, seats] = vals;
      parties.push({ name, votes, pct, electorate: electorate || 0, list: list || 0, seats: seats || 0 });
    }
    if (parties.length) break;
  }

  const counted = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:the\s+)?(?:votes?|voting places)\s+counted/i)
    || text.match(/counted[^%]{0,60}?(\d+(?:\.\d+)?)\s*%/i);
  const updated = text.match(/(?:last\s+)?updated:?\s*((?:\d{1,2}[:.]\d{2}\s*(?:am|pm)?[^.|]{0,30})|(?:\d{1,2}\s+\w+\s+\d{4}[^.|]{0,20}))/i);
  const stage = /official result/i.test(text) ? 'official' : /preliminary/i.test(text) ? 'preliminary' : null;

  return {
    parties,
    totals,
    countedPct: counted ? Number(counted[1]) : null,
    sourceUpdated: updated ? updated[1].trim() : null,
    stage,
    fetchedAt: new Date().toISOString(),
  };
}

// One electorate page. Pulls the summary block by its labels (VOTES COUNTED, LEADING CANDIDATE,
// 2nd CANDIDATE, MAJORITY) and the candidate table, where each candidate row carries that
// candidate's party in the second cell (blank = independent), as on the 2023 EC pages.
function parseElectorate(html, url) {
  const text = toText(html);

  const heading = [...html.matchAll(/<(h[1-3]|title)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => toText(m[2]).match(/^(.+?)\s+[-–]\s+(?:preliminary|official|progress)/i))
    .find((m) => m && !/general election/i.test(m[1]));
  const name = heading ? heading[1].replace(/^.*?\|\s*/, '').trim() : null;

  const counted = text.match(/votes counted:?\s*([\d,]+)\s+([\d.]+)\s*%/i);
  const lead = text.match(/leading candidate:?\s*([^\d|]+?)\s+([\d,]+)/i);
  const second = text.match(/2nd candidate:?\s*([^\d|]+?)\s+([\d,]+)/i);
  const majority = text.match(/(?:majority|margin):?\s*([\d,]+)/i);

  let candidates = [];
  for (const rows of tables(html)) {
    if (!rows.some((r) => r.some((c) => /^candidates?\b/i.test(c)))) continue;
    for (const r of rows) {
      const cm = (r[0] || '').match(/^([^\d]*[A-Za-zÀ-ž][^\d]*?)\s+([\d,]+)$/);
      if (!cm || /informal|total/i.test(cm[1])) continue;
      const pm = (r[1] || '').match(/^(.+?)\s+([\d,]+)$/);
      candidates.push({ name: cm[1].trim(), votes: num(cm[2]), party: pm ? pm[1].trim() : 'Independent' });
    }
    if (candidates.length) break;
  }
  candidates.sort((a, b) => b.votes - a.votes);

  let leader; let runnerUp; let margin;
  if (candidates.length >= 2) {
    [leader, runnerUp] = candidates;
    margin = leader.votes - runnerUp.votes;
  } else if (lead && second) {
    leader = { name: lead[1].trim(), votes: num(lead[2]), party: null };
    runnerUp = { name: second[1].trim(), votes: num(second[2]), party: null };
    margin = majority ? num(majority[1]) : leader.votes - runnerUp.votes;
  }

  return {
    url,
    name,
    countedVotes: counted ? num(counted[1]) : null,
    countedPct: counted ? Number(counted[2]) : null,
    leader: leader || null,
    runnerUp: runnerUp || null,
    margin: margin ?? null,
    candidates,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- discovery of electorate pages ----------

const DETAIL_RE = /electorate[-_]?details?[-_]?\d+/i;

async function discover(baseHtml) {
  const fromBase = links(baseHtml, BASE);
  let urls = fromBase.filter((u) => DETAIL_RE.test(u));
  if (urls.length) return { how: 'linked from the results page', urls };

  // follow "results by electorate"-style index pages
  for (const idx of fromBase.filter((u) => /electorate/i.test(u) && u.startsWith(BASE)).slice(0, 5)) {
    try {
      urls = links(await fetchPage(idx), idx).filter((u) => DETAIL_RE.test(u));
      if (urls.length) return { how: `linked from ${idx}`, urls };
    } catch (e) { logError(idx, e); }
  }

  // probe the 2023 naming scheme: electorate-details-1.html, -2, ...
  urls = [];
  let misses = 0;
  for (let i = 1; i < 100 && misses < 5; i++) {
    const u = new URL(`electorate-details-${i}.html`, BASE).href;
    try {
      ingestElectorate(u, await fetchPage(u));
      urls.push(u);
      misses = 0;
    } catch (e) {
      if (e.status === 404) misses++;
      else { logError(u, e); if (e.status === 403 || e.status === 429) break; }
    }
  }
  if (urls.length) return { how: 'probed electorate-details-N.html', urls };
  return null;
}

// ---------- state updates ----------

function ingestElectorate(url, html) {
  const next = parseElectorate(html, url);
  const prev = state.electorates.get(url);
  const history = prev?.history || [];
  const last = history.at(-1);
  if (next.margin != null && (!last || last.margin !== next.margin || last.leader !== next.leader?.name)) {
    history.push({ at: next.fetchedAt, margin: next.margin, leader: next.leader?.name, countedPct: next.countedPct });
    if (history.length > 40) history.shift();
  }
  state.electorates.set(url, { ...next, history });
}

async function pollOverall() {
  try {
    const html = await fetchPage(BASE);
    const overall = parseOverall(html);
    if (!overall.parties.length) throw new Error('No party table found on the results page (layout may have changed; run with --dump)');
    state.overall = overall;

    if (state.discovery.status !== 'ok' && (!state.discovery.at || Date.now() - Date.parse(state.discovery.at) > 120000)) {
      state.discovery = { status: 'searching', how: null, at: new Date().toISOString() };
      const found = await discover(html);
      if (found) {
        for (const u of found.urls) if (!state.electorates.has(u)) state.electorates.set(u, { url: u, history: [] });
        state.discovery = { status: 'ok', how: found.how, count: found.urls.length, at: new Date().toISOString() };
        console.log(`Found ${found.urls.length} electorate pages (${found.how})`);
      } else {
        state.discovery = { status: 'not-found', how: null, at: new Date().toISOString() };
        console.warn('No electorate pages found yet. Will retry in 2 minutes.');
      }
    }
  } catch (e) {
    logError(BASE, e);
  } finally {
    setTimeout(pollOverall, OVERALL_EVERY);
  }
}

// Close seats get refreshed roughly 4x as often as safe ones.
async function pollElectorates() {
  try {
    const now = Date.now();
    const due = [...state.electorates.values()]
      .map((e) => {
        const age = e.fetchedAt ? now - Date.parse(e.fetchedAt) : Infinity;
        const close = e.margin == null || e.margin <= WATCH_MARGIN;
        return { e, score: close ? age : age / 4 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, BATCH);
    await Promise.all(due.map(async ({ e }) => {
      try { ingestElectorate(e.url, await fetchPage(e.url)); } catch (err) { logError(e.url, err); }
    }));
  } finally {
    setTimeout(pollElectorates, TICK);
  }
}

// ---------- server ----------

function snapshot() {
  return {
    source: state.source,
    startedAt: state.startedAt,
    now: new Date().toISOString(),
    overall: state.overall,
    electorates: [...state.electorates.values()].filter((e) => e.fetchedAt),
    electoratesKnown: state.electorates.size,
    discovery: state.discovery,
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
  if (req.url === '/' || req.url.startsWith('/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(await readFile(path.join(HERE, 'index.html')));
  }
  res.writeHead(404).end('Not found');
});

server.listen(PORT, () => {
  console.log(`Polling ${BASE}`);
  console.log(`Dashboard on port ${PORT}`);
  pollOverall();
  setTimeout(pollElectorates, 3000);
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
function withSlash(u) { return /\.html?$/.test(u) || u.endsWith('/') ? u : u + '/'; }
