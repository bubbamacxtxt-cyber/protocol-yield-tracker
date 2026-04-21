# Pendle v2 plan

Date: 2026-04-21

## Why v2 exists

Pendle v1 is now intentionally narrow and honest:
- direct PT discovery
- direct YT discovery
- directly observed LP token balances only when trivial to prove
- unresolved DeBank Pendle fallback rows kept visible instead of being hidden

That is the correct v1 shape.

What remains unresolved is not a small bugfix lane. It is a real Pendle v2 problem:
- bundled fallback rows
- LP decomposition
- plasma bundle decomposition
- wrapped / reward-bearing / mixed-token fallback exposures

## V2 goal

Reduce unresolved Pendle fallback rows by decomposing bundled Pendle exposures into explicit PT / YT / LP / reward / underlying components where the mapping is defensible.

V2 success is **not** “delete all fallback rows”.
V2 success is:
- classify more Pendle rows accurately
- preserve uncertainty when exact decomposition is not yet provable
- reduce unresolved fallback USD without inventing fake certainty

## Current unresolved V2 set (from 2026-04-21)

### Main unresolved fallback exposures
- Yuzu eth ~ $4.24M
- Yuzu plasma ~ $199k
- Yuzu plasma ~ $50k
- Midas eth ~ $399.9k
- Midas eth ~ $78.9k

These are multi-address bundled rows in `position_index` and cannot be safely promoted by single-token mapping rules.

## What v1 taught us

### Confirmed lessons
1. direct PT/YT token discovery is reliable
2. `alchemy_getTokenBalances` misses some Pendle PT tokens
3. direct `balanceOf` against a Pendle token registry is required
4. wallet-wide DeBank suppression was wrong
5. generic fallback rows must remain visible until exact decomposition is possible
6. Pendle BFF is not for third-party integrations; use core API + onchain reads

## V2 principles

### Principle 1: exact decomposition over heuristic deletion
Do not remove fallback rows unless we can map them to a structured decomposition that preserves equivalent economic meaning.

### Principle 2: bundled rows are first-class objects
A bundled Pendle fallback row is not “bad data”; it is a real unresolved protocol bundle and should be modeled as such until decomposed.

### Principle 3: decompose components, not just labels
If a fallback blob includes:
- PT token
- YT token
- underlying token
- PENDLE reward token
- LP token / market token

then V2 should emit structured components or a structured bundle record, not just rename the row.

## Candidate V2 row model

### Option A — keep one parent bundled row plus components
Add fields like:
- `pendle_status: bundled`
- `normalization_status: partial` or `canonical_bundle`
- `pendle_bundle_components: [...]`

Components might include:
- token address
- inferred role (`pt`, `yt`, `underlying`, `reward`, `lp`, `unknown`)
- symbol
- inferred value attribution if available

This is the safest first V2 shape.

### Option B — emit child synthetic supply tokens onto the existing row
Attach `supply[]` entries inferred from bundle members without splitting the parent row.

This may be easier to integrate with current export but risks overclaiming value attribution.

### Recommendation
Start with **Option A** conceptually, but implement in current schema using enriched row metadata until schema evolution is justified.

## V2 workstreams

## Workstream 1: bundle parser
Build a parser for Pendle fallback `position_index` blobs:
- split comma-separated addresses
- map each address against Pendle core registry
- map known extras like PENDLE reward token and common underlyings
- classify bundle composition

Expected outputs:
- `single_token`
- `pt_plus_reward`
- `lp_bundle`
- `plasma_lp_bundle`
- `yt_plus_underlying`
- `unknown_bundle`

## Workstream 2: token-role registry
Create a Pendle-specific classification layer for:
- PT token
- YT token
- market / LP token
- SY token
- underlying token
- reward token (e.g. PENDLE)
- residual unknown token

This likely belongs in a shared helper, not inside export.

## Workstream 3: plasma coverage
Plasma now has RPC access, but V2 must explicitly handle:
- plasma market addresses
- plasma PT/YT/market roles
- plasma bundle decomposition

The current unresolved plasma rows strongly suggest bundle parsing is required even if direct token balances are available.

## Workstream 4: LP decomposition
The current LP situation is not solved by price lookup alone.

Need to answer for a fallback LP-like row:
- is it direct market LP token exposure?
- is it represented as PT + underlying + reward token?
- is DeBank surfacing a bundle rather than the LP token itself?

V2 should support bundle classification first, exact LP decomposition second.

## Workstream 5: fallback reduction metrics
Use `data/source-audit.json` as the scoreboard.

Track:
- unresolved fallback positions
- unresolved fallback USD
- Pendle unresolved fallback USD specifically

V2 progress should be measured as a decline in unresolved Pendle fallback USD **without regression in fixture checks**.

## Safe V2 milestones

### Milestone 1 — classify bundles without deleting them
- parse multi-address fallback rows
- label them with bundle type
- add component metadata
- keep rows unresolved but better described

### Milestone 2 — promote exact single-token rows safely
- only where direct equivalence is provable
- no wallet-wide suppression
- no LP auto-promotion yet

### Milestone 3 — structured LP bundle handling
- identify LP-like bundles
- attach component tokens and semantics
- optionally change normalization status from `unresolved` to `partial`

### Milestone 4 — plasma bundle handling
- same as LP bundle handling, but chain-specific

### Milestone 5 — selective fallback suppression
Only after exact overlap is provable between:
- bundle decomposition
- scanner/direct rows
- same wallet
- same chain
- same economic exposure

## What not to do in v2

Do not:
- suppress fallback by wallet alone
- relabel bundled rows as direct PT/YT without proof
- force LP decomposition from shaky price heuristics
- claim purchase-time locked APY or cost basis without event-history reconstruction

## Future v3 ideas

Only after V2 is stable:
- event-history reconstruction for locked PT rate and entry timing
- true LP decomposition with pool share accounting
- gauge/staked LP discovery if Pendle uses separate staking contracts in relevant cases

## Immediate next-step when resuming v2

1. read `data/source-audit.json`
2. isolate unresolved Pendle rows only
3. build a `parsePendleFallbackBundle()` helper
4. classify each unresolved row by bundle type
5. emit a report before changing export behavior

## Bottom line

Pendle v1 should stay narrow.
Pendle v2 is the right place to solve bundled fallback exposure.
The job is not “remove unresolved rows fast”; the job is “replace unresolved rows with structured, defensible Pendle semantics”.
