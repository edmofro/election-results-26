# election-results-26

Election night dashboard for the 2026 NZ general election: an RNZ-style seat horseshoe, the party
table, and every electorate with a lead under a threshold you set (default 1,000 votes).

Data comes from RNZ's results pages, which carry Electoral Commission data. (The EC's own results
site returns 403 to anything that isn't a browser.) One server-side poller is shared by every
viewer, so traffic to RNZ doesn't grow with the audience.

## Run locally

Node 18+, no dependencies.

```
npm start
open http://localhost:8026
```

`?threshold=500` on the dashboard URL sets the marginal cut-off on load (or use the input).

## What it polls

- `/news/election-2026-results` every 30 s: party votes, seats, electorate/list split, % counted.
- `/news/election-2026-results/electorates` every 30 s: leader, party and margin for all 71 seats.
- `/news/election-2026-results/electorate/<slug>` only for seats with a lead under 2,000, 3 pages
  every 10 s, tightest and stalest first. This is where runner-up and vote counts come from.

That's roughly 0.3 requests a second. Sends `If-None-Match` / `If-Modified-Since`.

Lead changes and margin movement are tracked from when the server starts (in memory only).

## Deploy on Railway

Railway builds from the `Dockerfile` and redeploys on every push to the connected branch.

1. New project, Deploy from GitHub repo, pick this repo.
2. Variables: `PORT` = `8026`. Networking: Generate Domain on port `8026`.
3. Optional: Settings, Deploy, Healthcheck Path `/healthz`.

| Env var        | Default                                               | What it does                                      |
| -------------- | ----------------------------------------------------- | ------------------------------------------------- |
| `BASE_URL`     | `https://www.rnz.co.nz/news/election-2026-results`    | RNZ results root                                  |
| `EVERY`        | `30`                                                  | Seconds between overview + electorates polls      |
| `TICK`         | `10`                                                  | Seconds between close-seat batches                |
| `BATCH`        | `3`                                                   | Close-seat pages per batch                        |
| `WATCH_MARGIN` | `2000`                                                | Seats under this margin get full candidate detail |
| `USER_AGENT`   | `election-results-26/1.0 (+repo URL; ...)`            | UA sent to RNZ                                    |

## Caveats

- The parser is written against RNZ's markup as saved on election night (Next.js, server-rendered
  tables). If RNZ changes it, run `node server.mjs --dump` and adjust the three `parse*` functions.
- RNZ's "% counted" is the share of voting places that have reported, not the share of votes.
- RNZ's terms of use and robots.txt weren't checked when this was written. Check them before
  running it anywhere public.
- Railway runs on datacentre IPs. If RNZ blocks those, the dashboard shows a "refused the last
  request" banner; run it locally instead.
