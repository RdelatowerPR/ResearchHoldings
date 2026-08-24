# ResearchHoldings

Dashboard tracking Blockworks Research holdings. Feel free to download or modify the repo.

Price data by [CoinGecko](https://www.coingecko.com/).
Equity data by AlphaVantage.

Holdings by Blockworks [Financial Disclosures](https://blockworks.com/financial-disclosures).

Live dashboard: https://research-holdings.vercel.app/

**Operators and coding agents:** read `AGENTS.md` before changing collection, CI, deployment, or
the Windows runtime. `CLAUDE.md` imports that same authority for Claude Code.

## Description

Two views:

- **Table View** — every entry in the database, with prices refreshed daily.
- **Analytics View** — insights on employee holdings and their performance.

## How the data gets there

The public data pipeline does not depend on an always-on local collector. The `Update Database`
GitHub Action runs daily at 00:00 UTC and commits the result to `main`, which Vercel redeploys.
Separately, the Windows `dashboards-control` supervisor maintains a loopback-only preview on
`127.0.0.1:3000`; it is not published through Cloudflare Tunnel.

```
scripts/scrapeHoldings.js   blockworks.com/financial-disclosures -> data/holdings.db
scripts/fetchPrices.js      CoinGecko + Alpha Vantage            -> prices table
```

Both write `logs/` (uploaded as a build artifact) and append a one-line record to
`data/run-history.jsonl`, which is committed.

**If the collector fails, the job fails and an issue is opened.** It used to exit 0
and report success on an empty scrape — see [docs/RUNBOOK.md](docs/RUNBOOK.md) for
that story and for what to do when data stops arriving.

## Running it

```bash
npm install
npm test              # parser, API client and backup tests - no network needed
npm run collect       # scrape holdings, then fetch prices
npm run dev           # dashboard at http://localhost:3000
```

Individually: `npm run scrape`, `npm run prices`, `npm run restore`.

CI uses Node 22 with `actions/checkout@v5` and `actions/setup-node@v5`, runs both `npm test` and
`npm run build`, and deliberately sets `package-manager-cache: false`. The daily workflow runs the
same tests before writing data, retains diagnostics as an artifact, and reports failures through a
`collector-failure` issue.

### Keys

Both are optional for a local run and read from the environment or a gitignored
`.env`. Without them, crypto prices fall back to CoinGecko's keyless endpoint and
equities are skipped.

```
COINGECKO_API_KEY=CG-...        # Pro key: pro-api.coingecko.com
ALPHA_VANTAGE_API_KEY=...       # equities
```

In CI both are repo secrets. If the CoinGecko key ever expires the client
[demotes itself](docs/RUNBOOK.md#coingecko-key-failed) to the keyless endpoint and
says so loudly rather than returning nothing.

## Data files

| Path | Committed | What it is |
| --- | --- | --- |
| `data/holdings.db` | yes | SQLite: members, holdings, prices, token mappings, holdings_history |
| `data/holdings-snapshot.json` | yes | text copy of every holding — diffable, restorable |
| `data/run-history.jsonl` | yes | one line per collector run; the audit trail |
| `data/metadata.json` | yes | last successful scrape, strategy used, source's own note |
| `backups/holdings-*.db` | no | last 7 pre-write database copies |
| `logs/`, `debug/` | no | verbose logs and the page dump written on a parse failure |

The `holdings_history` table inside the database is separate from `holdings`: it is
point-in-time (one row per capture date, member and asset) rather than current-state,
and holds the disclosures recovered from the Wayback Machine for the fourteen months
the collector was dark. See [docs/RUNBOOK.md](docs/RUNBOOK.md#recovering-missed-history).

`data/holdings-snapshot.json` exists because git can store a binary `.db` but can't
diff one. The daily commit shows exactly which holdings appeared or disappeared, and
`npm run restore` rebuilds the tables from it.

## Layout

```
scripts/
  scrapeHoldings.js       fetch -> parse -> guard -> write -> snapshot
  fetchPrices.js          token mapping and price collection
  restoreFromSnapshot.js  rebuild holdings from the committed snapshot
  backfillFromArchive.js  recover missed dates from the Wayback Machine
  lib/
    parseDisclosures.js   three independent readers for the page  (docs/PARSING.md)
    fetchPage.js          retries, URL fallback, response validation
    coingecko.js          API client with the expired-key failsafe
    backup.js             pre-write backups, snapshot write/restore
    history.js            point-in-time observations (holdings_history)
    logger.js             file + console logging, run records
test/
  fixtures/               real and synthetic page shapes
src/                      Next.js dashboard
```

## Documentation

- [docs/RUNBOOK.md](docs/RUNBOOK.md) — diagnosing failures, restoring data, keys
- [docs/PARSING.md](docs/PARSING.md) — how the page is read and how it degrades
