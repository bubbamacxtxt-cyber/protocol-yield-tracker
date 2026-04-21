# DeBank Cost / Runtime Plan

Date: 2026-04-21

## Goal

Reduce paid DeBank usage to a single daily wallet-recon lane and move all free discovery to hourly lanes.

## Paid daily lane

Use exactly one DeBank wallet-level recon scan per wallet:
- `GET /v1/user/all_complex_protocol_list?id={wallet}`

This single call should provide:
- active chains
- protocol exposure hints
- wallet+chain totals
- reconciliation baseline
- threshold gating (`>= $50k` per wallet+chain)

## Free hourly lanes

Run hourly:
- Alchemy token/vault discovery
- canonical YBS/vault matching
- protocol API scanners
- export
- source audit
- reconciliation against the last daily DeBank recon snapshot

## Current problem

DeBank is still spread across too many paths.
Likely active or semi-active consumers:
- `src/fetch.js`
- `src/build-debank-recon.js`
- `src/scan-whale.js`
- `src/scan-makina.js`
- old manual/debug/testing paths

The daily workflow also still passed `DEBANK_API_KEY` into scanners/validation that do not need it.

## Direction

### Keep
- `src/build-debank-recon.js` as the only daily paid DeBank lane

### Remove DeBank dependence from runtime lanes
- Aave scanner
- Morpho scanner
- validate.js
- any hourly free lane

### Re-evaluate legacy scripts
- `src/fetch.js` should either be retired from the main workflow or rewritten as a compatibility path only
- `scan-whale.js` and `scan-makina.js` should be treated as manual/debug utilities unless explicitly retained for production

## Threshold rule

After DeBank recon:
- if wallet+chain total >= $50k → active for deeper scanning
- if wallet+chain total < $50k → skip expensive position scanning for that wallet+chain
- still keep that wallet in future daily DeBank recon because whales rotate wallets

## Immediate next implementation steps

1. Fix `build-debank-recon.js` aggregation so wallet+chain totals are real
2. Make the recon output the canonical active/inactive gating source
3. Build Alchemy token discovery output from active wallet+chain pairs only
4. Build canonical token/vault match output from Alchemy discovery
5. Update reconciliation to compare modeled totals against the last daily recon snapshot
6. Remove or demote `src/fetch.js` from the main workflow once replacement coverage is sufficient
