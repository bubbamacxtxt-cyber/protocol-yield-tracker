# Source Semantics

## Goal

Make every exported position row explicit about where it came from, how trustworthy it is, and whether it is fully normalized.

## Required row-level fields

Every exported position should carry these fields:

- `source_type`
  - `scanner`
  - `protocol_api`
  - `manual`
  - `fallback`
  - `debank` (legacy transitional alias; migrate toward `fallback` where appropriate)

- `source_name`
  - concrete producer name, e.g. `aave-scanner`, `morpho-scanner`, `fetch`, `fetch-re`

- `source_priority`
  - numeric merge precedence
  - current target defaults:
    - scanner: 100
    - protocol_api: 80
    - manual: 70
    - fallback/debank: 40

- `confidence`
  - `high`, `medium`, `low`

- `normalization_status`
  - `canonical` = directly modeled and normalized
  - `partial` = valid row but not fully normalized to protocol-specific semantics
  - `unresolved` = intentionally retained fallback/bundled exposure

- `exposure_class`
  - `direct_position`
  - `bundled_protocol_fallback`
  - `manual_offchain`
  - extend as needed for indirect strategy exposure, wrapped exposure, etc.

## Current policy

### Scanner-covered protocols
- Aave / Morpho / Euler / Fluid scanner rows should generally be `scanner + high + canonical`

### Pendle
- direct PT/YT rows: `scanner + high + canonical`
- unresolved generic Pendle fallback rows: `fallback + low + unresolved`

### Manual/off-chain
- manual or off-chain rows should remain first-class, not degraded into fallback.

## Merge principle

Never suppress fallback rows unless exact overlap can be proven.

Safe suppression requires matching on more than wallet alone. At minimum:
- wallet
- chain
- canonical protocol
- exact token/vault/market identity
- material USD equivalence within tolerance

## Why this matters

The DeBank replacement project is no longer just about finding positions. It is about making source truth auditable. Explicit source semantics are how we stop export logic from silently inventing certainty.
