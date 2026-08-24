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
- Never commit `.env`, logs, debug pages, local backups, `.next`, or `node_modules`.
