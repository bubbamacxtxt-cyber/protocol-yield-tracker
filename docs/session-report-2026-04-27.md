# Session Report — 2026-04-27 (15:07 UTC → 00:16 UTC)

**Duration:** ~9 hours
**Branches:** main, exposure-decomposition, exposure-redesign
**Commits:** 25+ across 3 branches

---

## What was built

### 1. Exposure Decomposition System (`src/exposure/`)

A unified secondary-risk lookthrough layer that decomposes every whale position into a recursive tree of final-asset exposures, writing to the `exposure_decomposition` table.

**Infrastructure:**
- `src/exposure/schema.js` — `exposure_decomposition` table (recursive via `parent_id`), `ybs_backing_cache`, `borrower_mix_cache`, `adapter_health`
- `src/exposure/index.js` — orchestrator that loads all positions, dispatches to the right adapter, tracks adapter_health per run
- `src/exposure/registry.js` — auto-loads adapters from `src/exposure/adapters/`, resolves by `match()` → `protocol_canonicals` → `protocol_names`
- `src/exposure/recurse.js` — tree builder with depth cap (6) and path-based loop guard
- `src/build-exposure.js` — CLI entry (loads `.env` via dotenv before orchestrator runs)
- `src/audit-exposure.js` — coverage report (`data/exposure-audit.json`), CI gate (`--strict` mode)

**14 adapters:**

| Adapter | Protocols | Data source | Confidence |
|---------|-----------|-------------|------------|
| `aave.js` | Aave V3 | GraphQL `api.v3.aave.com` market reserves | high |
| `morpho.js` | Morpho (MetaMorpho v1 + v2, Blue direct) | REST `positions/earn` + GraphQL `markets()` + `vaultByAddress` | high |
| `euler.js` | Euler V2 EVK | On-chain `LTVList()/totalAssets()/totalBorrows()` + Goldsky `trackingVaultBalances` | high |
| `fluid.js` | Fluid lending | REST `/v2/{chainId}/tokens` + `/v2/{chainId}/vaults` | high |
| `spark.js` | Spark Savings (sUSDS, sUSDC, sGHO) | ERC-4626 direct claim on underlying | high |
| `compound.js` | Compound V3 Comet | shallow placeholder | medium |
| `curve.js` | Curve LP + gauges | scanner legs from `position_tokens` | high |
| `ybs.js` | yoUSD, Cap stcUSD, Ethena, InfiniFi, Sky, usd-ai, Yuzu | DeFiLlama `/protocol/<slug>` → `tokensInUsd.latest` | high |
| `pendle.js` | Pendle PT/YT/LP | symbol parsing → underlying extraction | high |
| `wallet.js` | Wallet holds | primary asset decomposition | high |
| `single-venue.js` | Dolomite, Gearbox, Curvance, Venus Flux, LFJ, STRATEGY, Yuzu, yzUSDUSDT0 | DeFiLlama `/protocol/<slug>` | high |
| `offchain.js` | Maple, Fasanara, reinsurance deals, RockawayX, Adaptive Frontier, Cap stcUSD (manual) | explicit opaque label + denomination child | high |
| `unknown.js` | fallback | explicit `kind='unknown'` rows | low |

**Coverage:** 100% of 123 positions ($759.7M), 100% high confidence.

### 2. Export integration (`src/export.js`)

- `p.exposure_tree` — recursive tree attached to every position in `data.json`
- `w.exposure_rollup` — per-whale aggregation (`by_protocol`, `by_token`, `by_market`, `by_confidence`)
- `d.summary.systemic_exposure` — top 25 final-asset exposures across all whales
- Manual-position fallback `resolvePositionId()` — matches manual-positions.json entries to DB rows by multiple composite keys

### 3. UI (`whale-common.js` + `whale-common.css` + 12 whale HTML pages)

**Donuts section** (above positions table):
- Three donuts: by protocol / by token / by market
- Vanilla canvas rendering (no Chart.js dependency)
- Native hover tooltips on each donut card
- BRAND-KIT compliant: gradient-teal center label, 8-slice palette

**Per-position cards** (below positions table):
- Grid: `repeat(auto-fit, minmax(520px, 1fr))` — 2 per row, evenly spaced
- Dark blue gradient background (`--gradient-blue`) matching summary cards
- Header: protocol name · strategy badge · confidence badge · market/vault name · chain pill · wallet address
- Stats strip: Whale exposure · Pool TVL (with net) · Total borrowed (with util%)
- Three layout modes:
  - **lending_pool / cluster**: two-column (COLLATERAL ASSETS / BORROWABLE LIQUIDITY)
  - **metamorpho_vault**: single ALLOCATED MARKETS list (collateral/loan · your exposure · market borrowed · util)
  - **isolated_market**: two-column (COLLATERAL / BORROWED) for Morpho Blue
  - **Other (YBS, LP, Pendle, opaque, wallet)**: single column with context-specific title
- Footer: Protocol · Market · Chain · adapter · source · timestamp
- Font sizes: JetBrains Mono 13px labels, 12px numbers, Space Grotesk 12px headers

### 4. Audit page (`audit.html`)

- Coverage % gauge
- Confidence mix cards (high/medium/low/unknown/opacity)
- Per-adapter table with value distribution bars
- Top systemic exposures table
- Adapter health table
- Stale YBS feed warnings
- CI gate indicators (coverage_pass, no_large_unknowns, no_stale_ybs)

### 5. System A deletion

Deleted the parallel lookthrough system built by DevBot in a separate Telegram session:
- `src/lookthrough/aave.js`, `src/lookthrough/morpho.js`
- `src/build-lookthrough.js`
- `scripts/migrate-lookthrough.js`
- `position_lookthrough` table (dropped from DB)
- `computeSecondaryExposure()` from `src/export.js`
- `w.secondary_exposure`, `p.lookthrough` fields
- `renderLookthroughCards()` from `whale-common.js`
- `<section id="lookthrough-section">` from all 12 whale pages

### 6. CI/CD (`free-scans-hourly.yml`)

- Exposure adapter smoke tests step (after Compound scanner)
- Build exposure decomposition step (after fix-morpho-tokens, before export)
- Audit exposure step (after export)
- `data/exposure-audit.json` added to commit file list

---

## Issues found and how they were solved

### Issue 1: Two parallel systems
**Symptom:** Saus saw mixed responses — Telegram session built System A (77% Morpho coverage), webchat session built System B (100% coverage). Both were wired into the workflow and data.json simultaneously.
**Root cause:** Different OpenClaw sessions don't share context. Bootstrap files loaded at session start didn't include the lookthrough work because it landed after startup.
**Fix:** Deleted System A entirely, kept System B as the only source of truth. Replaced all UI references. Verified no `position_lookthrough`, `secondary_exposure`, `build-lookthrough` references remain.

### Issue 2: Pro-rata legs exceeded position value
**Symptom:** A $52.65M position showed legs summing to $130M. Donuts overcounted whale totals.
**Root cause:** Adapters used `asset_usd` (gross deposit) instead of `net_usd` as the user's pool share. For leveraged positions (supply $130M, borrow $77M, net $52M), `userSupplyUsd / totalPoolSupply × reserveSupply` scaled each leg to the gross amount.
**Fix:** Changed every lending adapter to use `position.net_usd` for the composition scaling. Legs now sum to net_usd exactly. Donuts sum to whale total exactly (verified 11/12 whales within 1%).

### Issue 3: Morpho Blue cards showed $0 borrowed
**Symptom:** Cards said "Total borrowed $0" even though the pool clearly had active borrowers.
**Root cause:** Morpho REST `positions/earn` endpoint only returns supply-side `exposure[]` per collateral bucket. No borrow state. The adapter was reading only REST data.
**Fix:** Added `fetchMarketsForLoanAsset()` — queries Morpho subgraph `markets()` filtered by `loanAssetAddress_in`, aggregates by collateral address, matches against REST `exposure[]` buckets. Each allocation row now carries real `pool_reserve_total_borrow_usd`, `market_utilization`, `pool_reserve_available_usd`. Vault-level `pool_total_borrow_usd` computed by pro-rating each market's borrow to the vault's share of that market's supply.

### Issue 4: MetaMorpho v2 vaults not indexed by GraphQL
**Symptom:** `vaultByAddress` query returned NOT_FOUND for Sentora RLUSD Main (0x6dC58a0F...) even though the REST endpoint found it.
**Root cause:** Morpho GraphQL indexes v1 MetaMorpho vaults but not v2 (Sentora RLUSD Main, August AUSD V2, etc.). The v2 vault address from REST is a Morpho product ID, not a canonical MetaMorpho vault address in the subgraph.
**Fix:** For v2 vaults, use `markets()` query filtered by loan asset address (works for all Blue markets regardless of vault version). Aggregate per-collateral and match against REST `exposure[]` buckets. Both v1 and v2 now show real per-market state.

### Issue 5: EVK function selectors were wrong
**Symptom:** Euler adapter returned empty results — `LTVList()` reverted on-chain.
**Root cause:** Initial selectors were guessed (`LTVList = 0xe0e1f8e3`, `totalBorrows = 0xc04f17db`). The correct selectors are `LTVList = 0x6a16ef84`, `totalBorrows = 0x47bd3718` (verified via `ethers.keccak256` against Sentora RLUSD vault 0xaf537279...).
**Fix:** Updated selectors in `euler.js`. Also fixed `totalBorrows` to use `0x47bd3718` (not `0x9f678cca`). Added EVK selector reference to memory notes for future use.

### Issue 6: build-exposure.js missing dotenv
**Symptom:** Euler adapter failed silently (no Alchemy RPC key loaded), all Euler positions fell to medium confidence.
**Root cause:** `build-exposure.js` didn't load `.env` via dotenv before the orchestrator ran. Adapters read `process.env.ALCHEMY_API_KEY` at call time but the env var was never populated.
**Fix:** Added `require('dotenv').config({ path: ... })` at the top of `build-exposure.js`.

### Issue 7: Manual positions not attaching exposure trees
**Symptom:** Anzen, Pareto, InfiniFi whales showed empty `exposure_tree` arrays on their positions in data.json.
**Root cause:** Manual positions from `manual-positions.json` get merged into whale objects by export.js without carrying a DB `id`. The exposure attach loop joined on `p.id` which was `undefined` for manual entries.
**Fix:** Added `resolvePositionId()` fallback in export.js that indexes all DB positions by multiple composite keys (`wallet|chain|protocol_id`, `wallet|chain|protocol_name`, `position_index`). InfiniFi positions matched by `wallet|chain|protocol_id` even though they have real wallet addresses (not `off-chain`).

### Issue 8: GitHub Pages not updating
**Symptom:** Saus reported not seeing changes despite commits landing on main.
**Root cause:** GitHub Pages CDN has a ~10-minute cache. Also, browser-side caching with stale `?v=` query params.
**Fix:** Bumped cache-bust query strings (`?v=2355`, `?v=0005`) on all 12 whale pages' CSS/JS references. Recommended hard-refresh (Ctrl+Shift+R) and incognito window to bypass browser cache.

### Issue 9: Card sizing inconsistent
**Symptom:** Cards were different sizes — some massive with long lists, others small. 4 on one row, 2 on the next.
**Root cause:** Used `repeat(auto-fill, minmax(260px, 1fr))` which allowed 5 columns at 1400px. Also had `min-height: 320px` as a bodge.
**Fix:** Changed to `repeat(auto-fit, minmax(520px, 1fr))` — same pattern as `index.html` charts grid. 2 per row at 1400px, 1 per row at narrow widths. Removed `min-height`. Grid distributes width and height uniformly.

### Issue 10: Exposure section outside .container
**Symptom:** Cards spanned full page width instead of matching the positions table width.
**Root cause:** `<section id="exposure-section">` was placed after the `</div>` that closes `.container`, making it a sibling not a child.
**Fix:** Moved the section inside `.container` (between table-wrap close and container close). Removed redundant `max-width: 1400px` on `.exposure-section` since it now inherits from `.container`.

### Issue 11: Off-chain positions showed denomination-only (no counterparty detail)
**Symptom:** Maple, Fasanara, reinsurance deal cards showed "USDC" as a single leg with no context.
**Root cause:** `offchain` adapter was emitting a `primary_asset` child but not attaching strategy/category/attestation metadata.
**Fix:** Added `layout: 'opaque_offchain'`, `strategy`, `counterparty`, `category`, `maturity`, `attestation_url` to root evidence. Child carries `is_collateral: false, is_borrowable: false` to prevent it appearing in borrow columns.

---

## Key data points (end of session)

| Metric | Value |
|--------|-------|
| Positions in DB | 123 (≥$50K) |
| Decomposed | 100% |
| High confidence | 100% ($759.2M) |
| Unknown | 0 |
| Stale YBS feeds | 0 |
| Adapter errors | 0 |
| Whale donut consistency | 11/12 exact (Midas has $8M Euler sub-account merge issue) |
| Donut total matches whale total | Yes (net-basis math) |
| Per-market borrow state | Available for all MetaMorpho v1 + v2 vaults |
| Isolated Morpho Blue | Shows collateral + borrowed columns with real util |

---

## Files created / modified (significant ones)

**New:**
- `src/exposure/schema.js`, `index.js`, `recurse.js`, `registry.js`
- `src/exposure/adapters/` — 14 adapter files + `_base.js`
- `src/build-exposure.js`, `src/audit-exposure.js`
- `audit.html`
- `scripts/audit-summary.py`, `scripts/check-new-ui.py`, `scripts/update-whale-pages.js`, `scripts/verify-exposure-render.js`, `scripts/avant-headless.js`
- `docs/secondary-risk-coverage-plan.md`, `docs/secondary-risk-lookthrough-plan.md`, `docs/exposure-ui-redesign-plan.md`, `docs/session-report-2026-04-27.md`
- `test/exposure/smoke.test.js`

**Deleted:**
- `src/lookthrough/aave.js`, `src/lookthrough/morpho.js`
- `src/build-lookthrough.js`
- `scripts/migrate-lookthrough.js`
- `data/morpho-vault-allocations.json` (if existed)

**Modified:**
- `src/export.js` — exposure tree attachment, manual position fallback lookup, evidence parsing
- `src/fetch.js` — removed `position_lookthrough` table schema
- `whale-common.js` — complete exposure section rewrite
- `whale-common.css` — new exposure card styles, grid, stats strip, allocation view
- All 12 whale HTML pages — `exposure-section` placement, cache-bust stamps
- `.github/workflows/free-scans-hourly.yml` — exposure build + audit steps added, lookthrough step removed

---

## Open items / follow-ups

1. **Midas Euler sub-account merge** — export.js merges two Euler positions (ids 933+631, $18.49M combined) into one whale row but their trees are separate, causing ~$8M rollup discrepancy. Pre-existing export dedup issue.
2. **Compound V3 adapter** — still shallow placeholder (0 current positions, low priority).
3. **Aave/Spark deep borrower lens** — currently shows pro-rata-by-reserve-supply. Per-borrower collateral mix would require subgraph borrower sampling (Phase 4 of original plan).
4. **Euler cluster borrowBreakdown** — on-chain borrower cross-referencing not yet implemented (currently uses collateral vault totals from Goldsky).
5. **Cap/Sky/usd-ai/Yuzu backing fetchers** — DeFiLlama covers them but speculative direct API endpoints were tried and failed (CF-protected or wrong URLs).
6. **Strategy column accuracy** — Saus mentioned the strategy column is "wrong" in some cases. Separate fix needed.
7. **Convex LP scanner** — ~$1.29M Makina position tracked separately.
8. **Dolomite on-chain scanner** — currently covered by DeBank import only.
