# DeBank Replacement Audit — 2026-04-21

## Executive summary

The project is moving in the right direction: protocol-native scanners are now real, production-shaped components rather than just experiments. Aave, Morpho, Euler, Spark, and Pendle all have dedicated work landed. The architecture direction in `docs/debank-replacement-plan.md` is materially better than the older Alchemy-first or hybrid docs.

But the migration is still in an in-between state.

The main strengths today are:
- scanner-first architecture is established
- several major protocols already have direct scanners or protocol-native fetchers
- the export layer knows how to merge scanner and fallback data
- durable docs/plans exist for the replacement effort

The main weaknesses today are:
- source precedence is still inconsistent across protocols
- DeBank fallback rows are still mixed into core output without a universal confidence model
- protocol naming / protocol_id normalization is still messy in the DB and export
- some scanners still rely on heuristics that should be replaced by formal source contracts
- auditability is weaker than it should be for a migration of this size

Bottom line:
**The DeBank replacement project is viable and already partially successful, but it is not yet cleanly productized.**

---

## What has been accomplished so far

### 1. Architecture direction improved substantially

The current canonical planning doc is `docs/debank-replacement-plan.md`, and it makes the right core decisions:
- replace DeBank for on-chain DeFi with protocol-specific scanners
- do not try to clone DeBank generically first
- keep manual/off-chain lanes as first-class sources
- treat DeBank as migration fallback / reconciliation, not long-term truth

This is the correct framing.

### 2. Protocol-native scanners are real now

Based on code history and current repo state, the project has landed meaningful scanner work for:
- Aave
- Morpho
- Euler
- Spark
- Pendle

These are not paper designs anymore; they are part of the running workflow and export output.

### 3. Export layer is doing real merge/dedup work

`src/export.js` is already acting as the integration layer for:
- scanner rows
- DeBank rows
- manual/off-chain rows
- APY recomputation and rollups

This is good, because it means the migration has a single convergence point.

### 4. Pendle was corrected away from the wrong V1 shape

Pendle is the clearest example of the team learning the right lesson:
- the original V1 tried to normalize too much too early
- wallet-wide DeBank suppression was a mistake
- the better model is explicit two-lane handling:
  - direct PT/YT scanner rows
  - fallback unresolved Pendle rows

That correction was important and should be generalized.

---

## Current status snapshot

From the live DB/output at audit time:

### Global summary
- total positions: 145
- total value: ~$840.9M
- total whales: 12
- total wallets: 72
- active wallets: 53

### Important protocol totals visible now
- Aave variants dominate the book and are heavily scanner-covered
- Morpho direct scanner coverage is material
- Pendle direct scanner currently finds:
  - `pendle-pt`: ~$9.61M
  - `pendle-yt`: ~$83.6k
- Pendle fallback still remains:
  - `pendle2`: ~$5.76M
  - `plasma_pendle2`: ~$249.8k

That means Pendle is now partially replaced, not fully replaced. Which is acceptable if clearly represented.

---

## Audit findings

## A. What is strong

### A1. The repo has already escaped “DeBank as invisible truth”

This is the biggest win.
The system no longer depends conceptually on DeBank being the only way to know what exists. That alone is a major architecture improvement.

### A2. The docs show healthy course correction

There is a clear progression:
- `docs/scanner-architecture-v2.md` → obsolete Alchemy-first framing
- `docs/hybrid-architecture.md` → obsolete temporary hybrid framing
- `docs/debank-replacement-plan.md` → current correct framing

That evolution is healthy. It shows the project is learning rather than clinging to bad early assumptions.

### A3. Pendle exposed the right rule for the whole project

Pendle forced a useful principle:

> direct positions and unresolved fallback positions must not be conflated.

That same rule likely applies elsewhere too.

### A4. Memory and gotcha capture are starting to work

The project is capturing durable lessons, which lowers repeat failure risk.
That’s especially important in a migration project where external APIs and protocol semantics are messy.

---

## B. What is weak / risky

### B1. Source semantics are still not formalized enough

Today, rows from different source families still coexist in the same final output with only partial differentiation.

We need a stronger, uniform source contract for every position row.

Recommended required fields for every exported position:
- `source_type`
- `source_name`
- `source_priority`
- `confidence`
- `discovery_mode`
- `normalization_status`

Example values:
- scanner / protocol_api / manual / fallback
- aave-scanner / morpho-scanner / debank-fetch / fetch-re
- 100 / 80 / 60 / 40
- high / medium / low
- direct / inferred / bundled / manual
- canonical / partial / unresolved

Right now this is only partially present and inconsistent.

### B2. Protocol identity normalization is not clean enough

The DB snapshot still shows multiple protocol spellings/IDs for effectively related surfaces:
- `Aave V3` vs `Aave v3`
- `aave-v3` vs `aave3` vs chain-prefixed variants
- `Pendle` vs `Pendle V2`

This is survivable during migration, but it makes audits and exit-criteria harder.

This should be normalized via a canonical protocol registry.

### B3. Export is carrying too much migration logic

`src/export.js` is doing a lot:
- source normalization
- dedup
- APY recomputation
- manual overrides
- protocol-specific patches
- display fields

This works, but it is risky.
If export is where protocol truth gets repaired, the system becomes hard to reason about.

Preferred model:
- scanners/fetchers emit normalized rows
- export does light merge/display work, not major semantic surgery

### B4. Pendle LP/plasma/wrapped exposure remains unresolved

The direct Pendle scanner is now acceptable for PT/YT.
It is not yet a full Pendle position system.

Known gaps:
- LP decomposition is not reliable enough
- plasma positions are still fallback-only in output
- wrapped/gauge/bundled exposures are not formally modeled

This is okay for V1 if explicitly labeled, but not okay to leave ambiguous.

### B5. There is no formal migration scorecard in code output

The plan doc has the right matrix idea, but the build itself should produce a machine-readable migration status summary.

For example:
- coverage by protocol
- scanner-vs-fallback share of USD
- unresolved fallback share by protocol
- protocol readiness class: green/yellow/red

Without that, it is too easy to “feel” progress without measuring it.

---

## C. Protocol-specific audit notes

### C1. Aave
Status: strong

Why:
- direct scanner exists
- architecture appears stable
- major exposure is covered

Improve:
- normalize protocol naming/IDs
- ensure Aave variants are intentionally distinct where needed, not just string drift

### C2. Morpho
Status: strong

Why:
- REST-native path is well understood
- APY semantics are documented
- direct scanner architecture is coherent

Improve:
- continue reducing export-time repair logic
- ensure borrow/supply source attribution is explicit per row/token

### C3. Euler
Status: medium to strong

Why:
- scanner works
- architecture lesson is captured in gotchas

Risk:
- earlier indexer/subgraph confusion shows this area can regress if assumptions get reintroduced

Improve:
- formalize the registry/discovery/enrichment contract in code comments and tests

### C4. Spark
Status: medium

Why:
- meaningful progress landed
- canonical token correction was important

Risk:
- indirect-vs-direct Spark exposure remains subtle
- scanner semantics need a stricter model for “direct holding” vs “strategy exposure”

Improve:
- add explicit exposure class field in output

### C5. Pendle
Status: medium, but now sane

Why:
- the direct PT/YT scanner is useful
- architecture has been simplified to something honest

Risk:
- LP / plasma / wrapped exposure still unresolved
- fallback rows can still visually confuse users if not clearly labeled

Improve:
- keep two-lane model
- never hide unresolved fallback without exact match proof
- add user-facing labeling for direct vs fallback

---

## Suggested improvements

## Priority 1 — make the migration measurable

Add a generated audit artifact every run, e.g.:
`data/source-audit.json`

Include:
- positions by source_type
- USD by source_type
- positions by protocol x source_type
- unresolved fallback USD by protocol
- manual/offchain USD by protocol
- duplicate-risk rows count

This immediately makes the replacement project auditable.

## Priority 2 — add a canonical source contract

Every emitted position should carry normalized source metadata:
- `source_type`
- `source_name`
- `source_priority`
- `confidence`
- `normalization_status`
- `exposure_class`

This will reduce ambiguity across scanners and export.

## Priority 3 — create a protocol registry

Add something like:
`data/protocol-registry.json`

Define for each protocol:
- canonical id
- canonical display name
- scanner owner
- fallback ids
- chain-specific aliases
- expected exposure classes

This should drive normalization instead of ad hoc string fixes.

## Priority 4 — simplify export responsibilities

Move protocol-specific repair logic out of `src/export.js` where possible.

Export should mainly:
- merge
- dedup
- aggregate
- format display fields

Scanners/fetchers should own semantic normalization earlier.

## Priority 5 — formalize fallback handling

Fallback rows should be visibly different from direct rows.

Recommended fields:
- `normalization_status: unresolved`
- `exposure_class: bundled_protocol_fallback`
- `confidence: low|medium`

For Pendle specifically:
- `pendle_status: direct|fallback` is a good start
- extend that pattern to other protocols later

## Priority 6 — add exact-match suppression rules only

When suppressing fallback rows, only do it when exact equivalence can be proven.

Examples of valid suppression keys:
- same wallet
- same chain
- same canonical protocol
- same exact token/vault/market identity
- materially same USD exposure within tolerance

Never suppress by wallet-only.

## Priority 7 — add targeted test fixtures

This project needs stable fixture wallets for regression checks.

Minimum fixtures:
- one direct Aave wallet
- one Morpho vault wallet
- one Euler wallet
- one Spark indirect exposure wallet
- one Pendle PT/YT wallet
- one Pendle fallback-only wallet
- one manual/offchain-only entity

Then add a small regression script that asserts:
- positions still detected
- source type still correct
- fallback not incorrectly suppressed

## Priority 8 — demote obsolete docs more aggressively

The obsolete docs are correctly marked obsolete, but the repo would benefit from one short current architecture index page that says:
- what is current
- what is obsolete
- where to edit the truth

That prevents drift.

---

## Recommended next actions

### Immediate
1. Add `data/source-audit.json`
2. Add canonical source metadata fields across all emitted rows
3. Add protocol registry for canonical ids/names/aliases

### Near-term
4. Make Pendle fallback visually obvious in dashboard/export
5. Add fixture-based regression checks for scanner-covered protocols
6. Move protocol-specific cleanup logic out of export where feasible

### Medium-term
7. Define explicit exit criteria for turning DeBank off per protocol
8. Track fallback USD over time and require it to trend down
9. Split “fallback unresolved” from “manual/offchain” in summary reporting

---

## Final judgment

### Overall grade: B

This is no longer a vague “replace DeBank someday” idea.
It is an active migration with real scanners and real output.

Why not A yet:
- source semantics still need formalization
- fallback handling is still somewhat improvised
- export carries too much migration complexity
- protocol identity normalization is still messy

Why it’s better than a C:
- the architecture direction is now correct
- major scanner work is landed
- bad assumptions were corrected rather than defended
- the project is already producing valuable direct-source coverage

## The key recommendation in one line

**Keep pushing scanner-first, but stop relying on implicit merge behavior — formalize source semantics, measure fallback explicitly, and make unresolved rows first-class instead of half-hidden.**
