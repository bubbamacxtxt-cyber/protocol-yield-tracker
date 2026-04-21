# Exposure vs Issued-Asset Rules

Date: 2026-04-21

## Core distinction

There are two different concepts in this project and they must never be conflated.

### 1. Issued asset / vault token yield sourcing
Examples:
- sUSDe
- sUSDS
- stcUSD
- siUSD
- Upshift vault tokens / vault shares

For these, the project can use canonical registries for yield/APY:
- `data/stables.json` (YBS list)
- `data/vaults.json` (vault list)

This solves the question:
> what yield should this issued asset or vault token earn?

It does **not** solve the question:
> what protocol exposure should the whale page show?

### 2. Whale exposure / allocation tracking
Whale pages track what the monitored wallet is exposed to.
That means the page should reflect the destination/venue/protocol exposure of the wallet position.

Examples:
- if a wallet holds an Aave position, show Aave exposure
- if a wallet holds a Morpho position, show Morpho exposure
- if a wallet has unresolved Pendle bundle exposure, show Pendle Fallback

This solves the question:
> where is the whale/vault actually deployed?

It must not be overwritten just because the token or wrapper has a known yield source in YBS/vault registries.

## Hard rule

### DO NOT overwrite whale exposure protocol_name using YBS or vault registries.

YBS/vault registries may provide:
- APY source
- exposure class
- canonical metadata about the token/share

But they must **not** replace the actual exposure venue shown on the whale page unless the whale itself is that protocol and the page is explicitly intended as an issuer page rather than an allocation page.

### Scanner-owned protocol families dominate
If a wallet+chain already has a scanner-owned row for a protocol family, then:
- legacy DeBank-heavy rows for that same protocol family must not survive into final page output
- standalone issuer/enrichment rows for tokens embedded inside that scanner-owned venue row must not survive into final page output

This applies to families like:
- Aave
- Morpho
- Euler
- Spark
- Pendle direct

### Borrow-only fragments are not final exposure rows by default
If a protocol scanner emits borrow-only fragments but the intended modeled exposure is a combined venue position, those fragments should be merged or suppressed from final page output rather than rendered as separate standalone rows.

## Practical rule set

### For whale pages
Use:
- `protocol_name` / `protocol_canonical` to show actual exposure venue
- YBS/vault registries only to enrich APY and semantics

### Allowed YBS/vault enrichment on whale pages
- set `apy_base`
- set `apy_base_source`
- set `source_type` / `source_name` if the row is canonically understood
- set `exposure_class`

### Forbidden YBS/vault enrichment on whale pages
- do not replace `protocol_name` with issued-asset brand name just because APY came from YBS/vault list
- do not replace underlying exposure venue (e.g. Morpho, Aave, etc.) with issuer/brand token label
- do not relabel a whale's own page as if it were holding its own issued vault share unless that is literally what the wallet holds and the exposure being tracked is the issued asset itself

## Superform-specific rule

For Superform whale/vault pages:
- track the wallet's actual deployment exposure
- if the wallet is deployed into Morpho, show Morpho exposure
- do not rewrite protocol_name to Superform just because the whale entity is Superform
- Superform identity may appear at page/entity level, but row-level exposure must remain the actual venue

## General rule of thumb

### Entity name ≠ row exposure protocol
The page/entity title can be:
- Superform
- Reservoir
- Pareto
- etc.

But row protocol should answer:
> where is the capital actually deployed?

not:
> who owns/manages the wallet?

## Why this matters

If we confuse entity identity with row exposure protocol:
- pages become misleading
- protocol totals become wrong
- users cannot tell actual venue risk
- YBS/vault metadata starts corrupting exposure tracking

The correct model is:
- entity page = who the wallet belongs to
- row protocol = where the wallet is exposed
- YBS/vault lists = how to enrich issued-asset yield, not how to rewrite exposure venue
