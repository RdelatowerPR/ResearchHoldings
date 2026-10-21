# Research Holdings - project authority

Read this file before changing collection, data, deployment, or the local Windows runtime.
`CLAUDE.md` imports it so Claude Code and Codex share one continuity source.

## Two distinct runtimes

- The authoritative public deployment is Vercel. The daily `Update Database` GitHub Action writes
  committed data to `main`; collector failures must fail visibly and open an issue.
- The local production preview is managed by `dashboards-control` and starts Next.js with
  `-H 127.0.0.1 -p 3000`. It is local-only and must never be widened to the LAN.
- The local supervisor setting belongs in `dashboards-control`, not `package.json`, so daily bot
  commits and fast-forward updates keep working.

## Data and change safety

- Preserve the committed SQLite database, JSON snapshot, run history, metadata, and recovery docs.
- Never treat a successful workflow/process alone as data health; verify the last successful source
  capture and expected row counts.
- Run `npm test` and `npm run build` before release. Follow `docs/RUNBOOK.md` for collector failures.
- CI and the daily collector use Node 22 through `actions/checkout@v5` and `actions/setup-node@v5`.
  Keep `package-manager-cache: false`: this repository intentionally avoids setup-node's automatic
  npm cache and must not regress to deprecated Node 20-based action releases.
- `.github/workflows/test.yml` validates source changes. `.github/workflows/update-data.yml` runs
  daily at 00:00 UTC, tests before scraping, applies the committed price corrections, uploads
  failure artifacts, commits only the durable data files, and opens or updates a
  `collector-failure` issue when collection fails.
- Never rewrite stored prices in `data/holdings.db` by hand or in a PR: the daily data commit
  conflicts with any binary change and nobody can review one. Add a file to
  `data/price-corrections/` (built by `scripts/buildPriceCorrections.js`) and let the daily run
  apply it; see `docs/RUNBOOK.md#correcting-stored-prices`.
- Never commit `.env`, logs, debug pages, local backups, `.next`, or `node_modules`.
