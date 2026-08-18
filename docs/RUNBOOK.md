# Collector runbook

What to do when the data stops arriving, and why each safeguard is there.

## How the data actually gets collected

Nothing runs on a local machine. The `Update Database` GitHub Action runs daily at
00:00 UTC, scrapes the disclosures page, fetches prices, commits the results to
`main`, and Vercel redeploys `research-holdings.vercel.app` from that commit.

```
.github/workflows/update-data.yml
  npm test                      parser regression tests, before anything is written
  scripts/scrapeHoldings.js     page  -> data/holdings.db + metadata + snapshot
  scripts/fetchPrices.js        APIs  -> prices table
  git commit + push             data/ -> main -> Vercel
```

## The outage this was all built around

The scraper was written against `blockworks.co` when it was WordPress, keyed off
`h2.wp-block-heading` and `figure.wp-block-table`. Blockworks moved to
`blockworks.com` on Next.js + Chakra, and those selectors stopped matching anything.

The scrape then returned zero holdings, and the code wrote that result through: every
holding not seen "today" is marked inactive, so the entire register was flipped to
inactive and the dashboard went blank. Meanwhile the script crashed on an undefined
`fs`, swallowed it, and exited 0; the workflow wrote a fresh `metadata.json` on every
run regardless. So the job was green, the dashboard said "updated today", and the last
real data was **2025-06-18** — fourteen months earlier.

Every safeguard below exists because of one link in that chain.

## Diagnosing a failure

1. **Look at the run.** Actions → Update Database. A failure also opens (or comments
   on) an issue labelled `collector-failure`, so it doesn't need to be noticed.
2. **Download the `collector-logs` artifact.** It contains `logs/scrape.log`,
   `logs/prices.log`, and `debug/last-failed-page.html` — the exact page that could
   not be parsed. Actions console logs age out after 90 days; these are kept 30 days
   but the important state is committed (below).
3. **Read `data/run-history.jsonl`.** One committed JSON line per run:
   ```json
   {"at":"2026-08-17T21:52:45Z","job":"scrape","ok":true,"strategy":"dom",
    "scraped":182,"attempts":"dom=182,nextData=182,loose=182","active":182}
   ```
   This is the audit trail that answers "when did it last actually work". Check
   `strategy`, `scraped`, and `warnings`.

### "Every parsing strategy came back empty"

The page changed beyond recognition. Nothing was written — the database still holds
the last good data. Open `debug/last-failed-page.html`, compare it with
`test/fixtures/current-page.html`, then fix `scripts/lib/parseDisclosures.js` and add
a fixture for the new shape.

### "Scraped only N holdings against M currently active"

A partial parse. The write was refused rather than marking the difference inactive.
Confirm against the live page whether the drop is real. If Blockworks genuinely
removed people, re-run with `ALLOW_SHRINK=1 npm run scrape`.

### "Data came from the *nextData* / *loose* fallback reader"

**The run succeeded and the data is good, but the primary reader is broken.** The page
layout changed and the DOM parser no longer recognises it. Fix it before the fallback
breaks too. This warning is in the log, in `metadata.json`, and in the run record.

### "COINGECKO KEY FAILED"

The Pro key was rejected (expired, revoked, or over quota). The client demoted itself
to the keyless endpoint and kept collecting — slowly, and with dropped batches — so
prices will be patchy until the key is replaced. Rotate the key, then:

```bash
gh secret set COINGECKO_API_KEY -R RdelatowerPR/ResearchHoldings
```

The run record carries `"coingecko":"keyless","keyDemoted":"..."` for any run this
happened on.

## Restoring data

Three layers, in the order you'd reach for them.

| Layer | Where | Covers |
| --- | --- | --- |
| `data/holdings-snapshot.json` | committed, text | a bad write — diffable in the daily commit, restores with one command |
| git history of `data/holdings.db` | committed, binary | full database including price history |
| `backups/holdings-*.db` | local, gitignored, last 7 | a run that corrupted the file mid-write |

The snapshot is the one to use. Because it is text, `git log -p data/holdings-snapshot.json`
shows exactly which holdings appeared or disappeared on any given day.

```bash
git log --oneline -- data/holdings-snapshot.json      # find a good day
git checkout <sha> -- data/holdings-snapshot.json     # take that version
npm run restore                                        # rebuild members + holdings
```

`npm run restore` backs up the current database first and leaves the prices table
alone — prices are append-only history the snapshot deliberately doesn't carry.

## Running it by hand

```bash
npm test              # parser + client + backup tests, no network
npm run scrape        # page -> database
npm run prices        # APIs -> database
npm run collect       # both
```

Useful environment variables:

| Variable | Effect |
| --- | --- |
| `HOLDINGS_DB` | write to a scratch database instead of `data/holdings.db` |
| `BLOCKWORKS_URL` | scrape a different URL (a mirror, or a saved page) |
| `ALLOW_SHRINK=1` | permit a scrape much smaller than what's stored |
| `LOG_DIR`, `RUN_HISTORY`, `BACKUP_DIR` | redirect the collector's output |

To try something against real data without risking the real database:

```bash
cp data/holdings.db /tmp/scratch.db
HOLDINGS_DB=/tmp/scratch.db npm run scrape
```

## Keys

| Key | Used by | Stored |
| --- | --- | --- |
| `COINGECKO_API_KEY` | crypto prices | repo secret, and a gitignored local `.env` |
| `ALPHA_VANTAGE_API_KEY` | equity prices | repo secret |

Both are read from the environment only. The Alpha Vantage key was previously
hardcoded in `fetchPrices.js` and is still in git history — worth rotating.
Without `ALPHA_VANTAGE_API_KEY` equities are skipped with a warning rather than
silently priced at nothing.
