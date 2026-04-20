# Script Classification

_Updated: 2026-04-20_

This file classifies scripts in `src/` as production, dev utility, or archive candidate.

## Production

These are part of the active build pipeline or support current exported data.

- `aave-scanner.js`
- `morpho-scanner.js`
- `euler-scanner.js`
- `fetch.js`
- `fetch-infinifi.js`
- `fetch-anzen.js`
- `fetch-pareto.js`
- `fetch-re.js`
- `fetch-base-apy.js`
- `fetch-merkl.js`
- `enrich-markets.js`
- `export.js`
- `validate.js`
- `fix-morpho-tokens.js`

## Dev utility

Useful for investigation, support work, or future scanner work, but not core pipeline steps.

- `chain-reader.js`
- `fetch-helper.js`
- `fetch-stables.js`
- `fetch-vaults.js`
- `build-token-list.js`
- `export-vaults.js`
- `fix-aave-reserves.js`
- `morpho-rest-api.js`
- `dedup-wallet-tokens.js`
- `vault-discoverer.js`
- `scan-whale.js`
- `scan-makina.js`

## Archive / experiment candidates

These should not be treated as current architecture or production path without review.

- `hybrid-scanner.js`
- `wallet-scanner.js`

## Notes

### Why `hybrid-scanner.js` is archive candidate
It reflects an intermediate DeBank-replacement exploration and should not be treated as authoritative architecture.

### Why `wallet-scanner.js` is archive candidate
It reflects the older Alchemy-first wallet scan direction, which is no longer the canonical build path.

### Promotion rule
A script may move from `dev utility` to `production` only when:

1. it is used in the workflow or documented build path
2. it has a clear owner and purpose
3. it is consistent with `docs/debank-replacement-plan.md`
