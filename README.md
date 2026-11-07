# election-results-26

Election night dashboard for the 2026 NZ general election. Polls the Electoral Commission's
preliminary results at `electionresults.govt.nz/ge2026/` and shows an RNZ-style seat horseshoe, the
party table, and every electorate with a lead under a threshold you set (default 1,000 votes).

One server-side poller is shared by every viewer, so traffic to the EC doesn't grow with the audience.

## Run locally

Node 18+, no dependencies.

```
npm start
open http://localhost:8026
```

`?threshold=500` on the dashboard URL sets the marginal cut-off on load (or use the input).

## Deploy on Railway

Railway builds from the `Dockerfile` and redeploys on every push to the connected branch.

1. New project, Deploy from GitHub repo, pick this repo.
2. Settings, Networking, Generate Domain.
3. Optional: Settings, Deploy, Healthcheck Path `/healthz`.

No env vars are needed. Railway sets `PORT`. Everything else is optional:

| Env var         | Default                                        | What it does                                   |
| --------------- | ---------------------------------------------- | ---------------------------------------------- |
| `BASE_URL`      | `https://electionresults.govt.nz/ge2026/`      | Results page to poll                           |
| `OVERALL_EVERY` | `30`                                           | Seconds between party-vote polls               |
| `TICK`          | `10`                                           | Seconds between electorate batches             |
| `BATCH`         | `4`                                            | Electorate pages fetched per batch             |
| `WATCH_MARGIN`  | `2000`                                         | Seats under this margin are polled ~4x as often |
| `USER_AGENT`    | `nz-election-live/1.0 (...)`                   | UA sent to the EC                              |

State is in memory. A redeploy or restart reloads everything from the EC within a couple of minutes
but loses the lead-change and margin-movement history.

## What it polls, and how often

- Party vote page every 30 s.
- Electorate pages 4 every 10 s. Seats with a lead under 2,000 get checked about 4x as often as safe
  ones, so close seats refresh roughly every 30 s and the rest every few minutes.
- Sends `If-None-Match` / `If-Modified-Since`, so unchanged pages cost a 304.

## Known unknowns

The EC and RNZ results pages both refused automated fetches when this was built, so the parser was
written against the 2023 EC page layout plus the 2026 party table as it appears in search snippets.
Not verified against the live 2026 electorate pages:

- The electorate page URLs. It looks for links on the results page, then on any "electorate" index
  page it links to, then probes `electorate-details-1.html`, `-2`, ... (the 2023 scheme).
- The electorate page markup. It reads the `VOTES COUNTED` / `LEADING CANDIDATE` / `MAJORITY` block
  by label and assumes each candidate row carries that candidate's party in the next cell, as in 2023.

Railway runs on datacentre IPs, which bot protection is more likely to block than a home connection.
If the dashboard shows a "refused the last request" banner on Railway, run it locally instead.

If it can't find electorates or names look wrong, run locally with `node server.mjs --dump` (saves
every fetched page to `./dump`) and adjust `parseElectorate` / `discover` in `server.mjs`.

Dry run against the 2023 official results (same EC page family): `npm run dry-run-2023`.
