# DeBank Replacement Plan

_Updated: 2026-04-20_

This document is the canonical plan for reducing and eventually removing DeBank from the **on-chain position discovery** path in `protocol-yield-tracker-dev`.

## Executive Summary

We are going down the right path, with one important framing change:

- **Do replace DeBank for on-chain DeFi** with protocol-specific scanners and direct contract / RPC reads.
- **Do not try to build a generic DeBank clone first.**
- **Do not treat off-chain/manual positions as DeBank-derived truth.**
- **Do keep a first-class manual/off-chain data lane** for positions that are not discoverable from chain.

The build should become:

```text
Tracked entities
  → protocol-specific scanners for on-chain positions
  → direct RPC / contract reads for protocol gaps
  → manual/off-chain position pipeline
  → merge / dedup / validate
  → optional DeBank reconciliation during migration only
```

## What We Confirmed Today

### 1. Scanner-first is the right architecture for lending

For Aave and Morpho especially, protocol-native sources are better than DeBank:

- exact market identity
- exact vault / position context
- APY and reward fields from source systems
- better semantics for leverage, collateral, and borrow state

This also appears true for Euler and Fluid.

### 2. Alchemy is a tool, not the source of truth

Alchemy is useful for:

- RPC access
- raw contract reads
- metadata lookup
- occasional balance discovery

Alchemy should **not** be the core universal discovery engine.

Why:

- `alchemy_getTokenBalances` is incomplete for some protocol tokens
- coverage varies by chain / network enablement / token indexing
- balance discovery alone does not explain protocol semantics

### 3. Off-chain/manual positions are already their own source lane

The repo already proves this.

Examples:

- `fetch-anzen.js` writes positions with `wallet: "off-chain"` and `manual: true`
- `fetch-pareto.js` does the same
- `fetch-re.js` creates a mixed model: on-chain wallet balances + an off-chain manual reserve position
- `manual-positions.json` is already a real data source

So the architecture must explicitly separate:

1. **On-chain discoverable positions**
2. **API-derived positions**
3. **Manual/off-chain positions**

### 4. DeBank is currently doing too many jobs at once

Today it is effectively used as:

- broad wallet / chain / protocol discovery
- fallback source for uncovered on-chain protocols
- temporary comparison source while scanners mature

That is acceptable during migration, but it should not stay the primary production backbone if we can scan the same protocols directly.

## Current Source Architecture

This is the real source map in the current dev build.

### Source Type A: protocol-specific scanners / native APIs

Current examples:

- `src/aave-scanner.js`
- `src/morpho-scanner.js`
- `src/euler-scanner.js`
- `src/fetch-infinifi.js` (protocol API, but writes into manual lane today)
- `src/fetch-re.js` (mixed on-chain + off-chain)

### Source Type B: DeBank broad scan

Current example:

- `src/fetch.js`

Used for:

- wallet chain discovery
- chain balances
- complex protocol position discovery

### Source Type C: manual / off-chain / custom generators

Current examples:

- `src/fetch-anzen.js`
- `src/fetch-pareto.js`
- `src/fetch-re.js` off-chain reserve position
- `data/manual-positions.json`

This lane is not a temporary hack. It is a real part of the system.

## Target Architecture

## Layer 1: tracked entity registry

We need one clean inventory of tracked entities with explicit source expectations.

Each entity should declare:

- name
- type: `onchain`, `offchain`, `mixed`
- wallet addresses, if any
- chains
- expected protocols
- preferred source strategy

Example shape:

```json
{
  "name": "Re Protocol",
  "type": "mixed",
  "wallets": ["0x...", "0x..."],
  "chains": ["eth", "avalanche"],
  "sourcePolicy": {
    "onchain": ["ethena", "curve"],
    "manual": ["re-offchain-reserves"]
  }
}
```

## Layer 2: protocol scanners

Protocol scanners are the preferred source for on-chain DeFi.

Each scanner should return a normalized position model with:

- wallet
- chain
- protocol_id
- protocol_name
- position_type
- strategy
- net_usd / asset_usd / debt_usd
- exact market or vault identifier
- APY fields with source attribution
- rewards where available
- scanned_at
- source metadata

### Scanner design principles

- prefer protocol-native APIs over generic token scanning
- use direct RPC only where necessary
- batch reads where possible
- record exact identifiers used for dedup and QA

## Layer 3: direct contract-read helpers

Shared helpers should support:

- `balanceOf(address)`
- `decimals()`
- `symbol()`
- `name()`
- ERC-4626 methods such as `asset()`, `convertToAssets()`, `previewRedeem()` when relevant
- multicall batching where feasible

This should be a shared utility layer, not reimplemented per scanner.

## Layer 4: manual / off-chain positions

Manual/off-chain positions need a formal workflow and schema, not just ad hoc JSON writes.

Minimum required fields:

- entity name
- source owner
- provenance / source note
- last updated timestamp
- method of valuation
- confidence level or verification status
- maturity / bucket / preference when relevant
- `manual: true`
- explicit reason the position is not chain-discoverable

## Layer 5: merge, dedup, and precedence

We need deterministic merge rules.

### Proposed precedence

1. protocol scanner
2. direct protocol API fetcher
3. manual/off-chain
4. DeBank fallback

### Core rules

- if a protocol scanner and DeBank both find the same on-chain position, prefer scanner
- manual positions are independent unless explicitly linked to an on-chain equivalent
- mixed entities must allow both manual and on-chain positions to coexist cleanly
- stable position keys are mandatory

## Layer 6: reconciliation / QA

During migration, every run should produce:

- totals by whale
- totals by protocol
- totals by chain
- diff vs previous run
- diff vs DeBank where DeBank is still enabled
- explicit missing-source warnings

## Protocol Coverage Matrix Template

Use this table to manage migration.

| Protocol / Exposure | Current Source | Target Source | Entity Type | Value Covered | Complexity | Confidence | Blocker | Next Step | Exit Condition |
|---|---|---|---|---:|---|---|---|---|---|
| Aave V3 | Scanner + DeBank | Scanner | onchain | 0 | Low | High | None | verify full coverage | no DeBank dependence |
| Morpho | Scanner + DeBank | Scanner | onchain | 0 | Low | High | None | verify full coverage | no DeBank dependence |
| Euler | Scanner + DeBank | Scanner | onchain | 0 | Medium | High | None | verify edge cases | no DeBank dependence |
| Fluid | Scanner + DeBank | Scanner | onchain | 0 | Medium | Medium | validation | finish QA | no DeBank dependence |
| Ethena | DeBank | Scanner | onchain | 0 | Medium | Medium | exact source selection | build scanner | scanner matches known totals |
| Spark | Manual/API mix | Scanner/API | onchain | 0 | Medium | Medium | confirm exact contract/API path | build source | no DeBank dependence |
| Pendle | DeBank | Scanner | onchain | 0 | High | Low | PT/YT semantics | design scanner | stable valuation + IDs |
| Curve | DeBank | Scanner/API | onchain | 0 | Medium | Low | LP/gauge valuation | design scanner | stable pool mapping |
| Anzen | Manual generator | Manual generator | offchain | 0 | Low | Medium | provenance docs | formalize schema | owned manual workflow |
| Re off-chain reserves | Manual generator | Manual generator | mixed | 0 | Medium | Medium | source policy | formalize schema | owned manual workflow |
| Pareto | Manual generator | Manual generator | offchain | 0 | Low | Medium | provenance docs | formalize schema | owned manual workflow |

Populate `Value Covered` with current tracked USD exposure and update the table as scanners land.

## Phased Milestones

## Phase 0: clean conceptual model

Goal: stop mixing incompatible source types.

Tasks:

1. Create a canonical source taxonomy:
   - `scanner`
   - `protocol_api`
   - `manual`
   - `debank_fallback`
2. Mark every current whale / position source accordingly.
3. Document which entities are `onchain`, `offchain`, or `mixed`.
4. Update docs so old assumptions do not keep leaking back into design.

Exit condition:

- one current architecture doc exists and stale competing docs are marked obsolete or updated

## Phase 1: lock the proven lending core

Goal: make the existing scanners production-grade and DeBank-independent.

Protocols:

- Aave
- Morpho
- Euler
- Fluid

Tasks:

1. Verify wallet-by-wallet coverage.
2. Verify exact market / vault identity.
3. Verify APY and reward attribution.
4. Ensure export and dedup logic no longer relies on DeBank interpretation for these protocols.

Exit condition:

- these protocols remain correct when DeBank output is ignored for them

## Phase 2: highest-value missing on-chain protocols

Priority order should be value-first and semantics-aware.

Recommended order:

1. Ethena
2. Spark
3. Pendle
4. Curve
5. Gearbox / Sky / cap / Upshift / Convex / Dolomite / LFJ / Venus Flux / Curvance

### Why this order

- Ethena is large and likely straightforward relative to value
- Spark is close to Aave in shape
- Pendle is important but trickier, so it needs explicit design work
- Curve is useful but LP / gauge semantics need care

Exit condition:

- the majority of on-chain exposure is covered by first-party scanners or protocol APIs

## Phase 3: formalize manual/off-chain pipeline

Goal: make off-chain positions auditable and maintainable.

Tasks:

1. Normalize `manual-positions.json` schema.
2. Add provenance fields.
3. Add validation rules.
4. Define update ownership and cadence.
5. Split manual generators from true scanner code conceptually and perhaps structurally.

Exit condition:

- off-chain/manual positions are explicit, owned, and validated

## Phase 4: DeBank reduction

Goal: move DeBank from production dependency to migration / QA tool.

Stages:

### Stage A: reconciliation mode

- keep DeBank running
- compare DeBank against scanner outputs
- alert on mismatches

### Stage B: partial fallback mode

- DeBank only used for protocols still uncovered
- DeBank output labeled as fallback

### Stage C: optional audit mode

- disable DeBank in main production path
- run occasional audit / comparison jobs only if needed

Exit condition:

- production output no longer requires DeBank for on-chain DeFi

## Main Risks

## 1. discovery is easier than identification

Finding a token or balance is not the same as identifying:

- the exact protocol
- the exact market or vault
- how to value it
- how to calculate APY / rewards

This is why protocol-specific scanners are the right path.

## 2. wrappers and vault pricing can be tricky

Problems likely to appear:

- share vs asset accounting
- stale price assumptions
- rebasing wrappers
- nested vaults
- ERC-4626-ish contracts that are not clean ERC-4626 implementations

## 3. Pendle and LP semantics are harder than lending

Need explicit data-model decisions for:

- PT
- YT
- LP tokens
- expiry and maturity
- implied yield vs realized yield
- reward splits

## 4. mixed-source entities can create duplicate or contradictory positions

Example:

- one whale may have real wallets plus manual reserve entries
- export and validation must not accidentally merge unlike positions

## 5. stale docs will cause repeated design mistakes

This already happened today. Some docs still imply:

- generic Alchemy token scan is the main future architecture
- DeBank is cheap enough to keep as the core forever
- manual/off-chain and DeBank data are conceptually the same lane

They are not.

## Exit Criteria

We should consider the DeBank replacement successful when all of the following are true:

1. **All major on-chain DeFi protocols in tracked exposure are scanner- or API-derived.**
2. **Manual/off-chain positions are maintained through an owned, explicit workflow.**
3. **DeBank is no longer required for production on-chain position discovery.**
4. **Validation can reconcile totals without relying on DeBank for covered protocols.**
5. **Protocol coverage and source ownership are documented and testable.**

## Recommended Build Plan From Here

1. Make this document the canonical source of truth.
2. Create a real protocol coverage matrix and fill in tracked USD values.
3. Verify Aave / Morpho / Euler / Fluid are fully DeBank-independent.
4. Build Ethena scanner.
5. Build Spark scanner or Spark-specific extension of existing lending logic.
6. Design Pendle scanner before coding it.
7. Design Curve scanner with LP and gauge handling explicitly.
8. Formalize manual/off-chain schema and ownership.
9. Move DeBank into reconciliation-only mode once coverage is good enough.

## Cleanup Needed In Current Dev Build

These are the main cleanup items visible today.

### 1. stale architecture docs

These docs need either updating or an obsolete banner:

- `docs/hybrid-architecture.md`
- `docs/scanner-architecture-v2.md`

Why:

- they encode assumptions we no longer trust
- they blur scanner, Alchemy, DeBank, and manual lanes
- they will keep causing planning errors if left as-is

### 2. manual vs scanner naming is muddy

Examples:

- `fetch-infinifi.js` pulls live API data but marks all outputs `manual: true`
- `fetch-re.js` mixes on-chain and off-chain logic in one script
- manual/off-chain data and protocol API data both land in `manual-positions.json`

Recommendation:

Introduce explicit source tags such as:

- `source_type: "protocol_api"`
- `source_type: "scanner"`
- `source_type: "manual"`
- `source_type: "debank"`

And reserve `manual: true` only for truly manual / off-chain positions.

### 3. workflow comments are conceptually outdated

`.github/workflows/update.yml` currently groups sources in a way that no longer reflects reality.

It should document:

- DeBank broad scan
- protocol scanners
- custom API/manual generators
- export and validation

More importantly, it should state which source is authoritative for which protocols.

### 4. source ownership is not formalized enough

We need a table or config that says, for each protocol / entity:

- current source
- target source
- owner script
- fallback source

Right now that knowledge is scattered across scripts, docs, and memory.

### 5. scratch / exploration scripts should be reviewed

The following are likely exploratory or transitional and should be reviewed for keep/remove/archive:

- `src/hybrid-scanner.js`
- `src/wallet-scanner.js`
- `src/vault-discoverer.js`
- `src/scan-whale.js`
- `src/scan-makina.js`

Not all of these must be deleted, but each should be classified as one of:

- production
- dev utility
- archived experiment

### 6. validation rules need source awareness

`src/validate.js` already has special cases for manual-only whales.
That is a sign the validation model needs explicit source classification rather than whale-name exceptions.

Recommendation:

Move from special-case names to source-aware validation rules.

## Immediate Next Steps

1. Approve this doc as the canonical plan.
2. Build the protocol coverage matrix with real USD exposure values.
3. Decide source tagging schema.
4. Audit current scripts into production vs utility vs archive.
5. Start with Ethena as the next major on-chain replacement target.
