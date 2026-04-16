# PRODUCTION REPO

This is the **production** Protocol Yield Tracker.

## Rules
- **Stable only** — no experimental edits directly here
- Only full tested releases from the dev repo land here
- Do not cherry-pick partial updates

## Deployment
- GitHub Pages: `https://bubbamacxtxt-cyber.github.io/protocol-yield-tracker/`
- Source: `main` branch (legacy Pages deployment)
- Workflows: `update.yml` (daily DeBank scan), `vaults.yml` (vault data refresh)

## Dev repo
- `protocol-yield-tracker-dev` — all experimentation happens there
- When ready: ship the **entire tested dev repo state** to prod

## Release process
See `RELEASE.md` for full promotion steps.
