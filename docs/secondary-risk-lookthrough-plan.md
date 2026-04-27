# Secondary Risk Lookthrough — Plan

**Status:** Draft
**Created:** 2026-04-27
**Goal:** For every whale position in a shared lending pool or vault, enumerate all other collateral/loan assets in that pool and the **pro-rata exposure** the whale has to each. Surface it in a detail modal per position, then summarize per whale the way `reservoir-monitor.vercel.app` does (by protocol / by token / by market exposure donuts).

---

## 1. Why

Right now the tracker says "whale X lends $50M USDe on Aave Plasma" and stops there. But that whale's USDe is pooled with every other supplier, and borrowers in that pool can draw against **any collateral Aave accepts**. If one of those collaterals (say a weird LRT) gets exploited, depositors in the pool are left with bad debt. That's secondary risk, and we don't show it.

Same for Morpho MetaMorpho vaults: a whale deposits into `Sentora RLUSD`, but that vault routes to ~6 markets each with a different collateral (syrupUSDC, weETH, cbBTC, sUSDe, wstETH). The whale's $33M is **actually** exposed to all of them pro-rata.

Same for Euler clusters: the USDC sub-vault takes syrupUSDC/sUSDe/PT-sUSDE collateral, so USDC suppliers eat any bad debt from any of those borrowers.

**Core idea:** take `reservoir-monitor`'s approach and generalize it across **every scanner** we already have, for **every whale**.

---

## 2. What reservoir-monitor does (reference implementation)

Live endpoint: `https://reservoir-monitor.vercel.app/api/data`

They produce a single JSON payload:
```
{
  ok, ts, grandTotal,
  wallets: [{ address, label, totalUsd, positions: [{protocol, tokens, value}] }],
  morpho: { <walletAddress>: [{ vaultName, vaultAddress, asset, deposited, vaultTotal, share, markets: [{collateral, loan, vaultSupply, proRata, pct, utilization}] }] },
  euler: { <clusterName>: { totalAssets, totalBorrows, utilization, vault, asset, collateralVaults: [...], borrowBreakdown: [{collateral, pct, amount}] } },
  dolomite: { totalSupply, totalBorrows, utilization, ... }
}
```

Three lookthrough patterns:

### A. Morpho MetaMorpho vault lookthrough
1. Get vault's allocation list (which markets it supplies to)
2. For each market, get the collateral asset + loan asset + vaultSupply (how much of the vault's money is in that market)
3. User's share = `userDeposit / vaultTotalAssets`
4. User's pro-rata exposure to each collateral = `share × vaultSupply`
5. Render a card with markets ranked by proRata

### B. Euler EVK cluster lookthrough
1. Start from the vault (e.g. RLUSD Sentora vault `0xaf5372...`)
2. Query `totalAssets()` and `totalBorrows()` on the loan vault
3. Enumerate "collateral vaults" — the sub-vaults in the cluster that can be posted as collateral against this loan vault
4. Cross-reference on-chain: sample recent borrowers and tally their collateral types → `borrowBreakdown` (% of borrows backed by each collateral)
5. User share = `userSupply / totalAssets`; pro-rata borrows = `totalBorrows × share`; final exposure per collateral = `borrowBreakdown[i].amount × share`

### C. Dolomite / Aave-style pooled lookthrough
1. Single pool with many reserves
2. Each reserve has supply + borrow
3. User's share of the lending side = `userSupply / reserveTotalSupply`
4. User's pro-rata claim on pool assets = their share × every other reserve's supply (because pool solvency depends on all of it)
5. For Aave specifically: pro-rata collateral exposure = `userSupply × (otherCollateral_totalSupply / loanAsset_totalSupply)` — this is the secondary risk lens

---

## 3. Architecture

### 3.1 New data model — `position_lookthrough`

Add a child table to the existing `positions` schema:

```sql
CREATE TABLE IF NOT EXISTS position_lookthrough (
  id INTEGER PRIMARY KEY,
  position_id INTEGER REFERENCES positions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- 'morpho_vault' | 'euler_cluster' | 'aave_pool' | 'dolomite'
  market_key TEXT,             -- morpho uniqueKey / euler vault addr / aave reserve addr
  collateral_symbol TEXT,      -- e.g. 'syrupUSDC'
  collateral_address TEXT,
  loan_symbol TEXT,            -- e.g. 'RLUSD'
  loan_address TEXT,
  chain TEXT,
  total_supply_usd REAL,       -- vault's deposit into that market, or reserve's total
  total_borrow_usd REAL,
  utilization REAL,            -- 0..1
  pro_rata_usd REAL,           -- what the whale "owns" of that market (in USD)
  share_pct REAL,              -- whale's share of the parent pool (0..100)
  rank_order INTEGER,          -- 1-based rank within this position
  metadata_json TEXT,          -- anything else (liquidation price, collateral factor, HF of borrower, etc.)
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(position_id, kind, market_key, collateral_address)
);
CREATE INDEX idx_lookthrough_position ON position_lookthrough(position_id);
CREATE INDEX idx_lookthrough_market ON position_lookthrough(kind, market_key);
```

Every scanner row can now link to 0..N lookthrough rows. Wallet-held, YBS, ethena-cooldown stay at 0 (no pool).

### 3.2 New scanner: `src/lookthrough/`

One module per pattern:

| File | Handles | Data source |
|------|---------|-------------|
| `src/lookthrough/morpho.js` | All `morpho-scanner` rows (v1 + v2) | Morpho GraphQL `vaultByAddress { state { allocation { market { collateralAsset loanAsset } assets } } }` |
| `src/lookthrough/euler.js` | All `euler-scanner` rows | Goldsky subgraph for markets + on-chain RPC for totalAssets/totalBorrows/collateralVaults; borrower sampling via Goldsky account list |
| `src/lookthrough/aave.js` | All `aave-scanner` rows | Aave v3 GraphQL `market(request:{address, chainId}){ reserves { currency { symbol address } aTokenBalance vTokenBalance supplyInfo { apy.value } } }` |
| `src/lookthrough/fluid.js` | Fluid positions | Fluid REST `tokens` endpoint already has `totalSupply` / `totalBorrow` |
| `src/lookthrough/compound.js` | Compound V3 Comet | Direct RPC `getTotalSupply()` / `getBorrowRate()` per market |
| `src/lookthrough/spark.js` | Spark (Aave fork) | Reuse aave.js helper with Spark market list |
| `src/lookthrough/curve.js` | Curve pools | LP pool composition is already in `curve_pools` — re-use; secondary risk is "other tokens in the pool" |

Each module exports `async function compute(positions, db) → lookthroughRows[]`.

### 3.3 Orchestrator: `src/build-lookthrough.js`

Pipeline:
1. Open DB, read all `positions` rows
2. Clear stale `position_lookthrough` rows (by `computed_at < scanStart`)
3. Route each position to the right lookthrough module based on `protocol_canonical`:
   - `morpho` → morpho.js
   - `euler` → euler.js
   - `aave` → aave.js
   - `fluid` → fluid.js
   - `compound` → compound.js
   - `spark` → spark.js
   - `curve` → curve.js
4. Write batched inserts; log summary per protocol
5. Exit 0; CI fails only on hard errors, not missing lookthrough (some edge-case positions won't have one, that's fine)

### 3.4 Export integration

In `src/export.js` `finalizeSourceMeta` loop, after we build each whale's `positions`, also attach:
```js
p.lookthrough = db.prepare('SELECT kind, collateral_symbol, loan_symbol, chain, total_supply_usd, total_borrow_usd, utilization, pro_rata_usd, share_pct, rank_order, metadata_json FROM position_lookthrough WHERE position_id = ? ORDER BY pro_rata_usd DESC').all(p.id);
```

Then compute per-whale rollups into `w.secondary_exposure`:
```js
w.secondary_exposure = {
  by_protocol: [{ protocol, usd, pct }, ...],
  by_token: [{ symbol, usd, pct }, ...],         // collateral tokens from lookthrough
  by_market: [{ market_key, label, usd, pct }, ...]  // pool/vault-level
}
```

Source-of-truth rule: **lookthrough is protocol-scanner derived, never wallet-derived**. Wallet-held/YBS/ethena never get lookthrough rows.

---

## 4. UI

### 4.1 Position detail modal (per row click)

Extend `whale-common.js` modal. When a row has `lookthrough.length > 0`, add a section:

```
FINAL MARKET EXPOSURE (pro-rata X.X%)
┌────────────────────────────────────────────┐
│ syrupUSDC / RLUSD       $25.76M   75.8%   │
│ weETH / RLUSD            $2.89M    8.5%   │
│ cbBTC / RLUSD            $130K     0.4%   │
│ Idle RLUSD               $5.14M   15.1%   │
└────────────────────────────────────────────┘
Source: Morpho GraphQL | Vault Sentora RLUSD (senRLUSD) | TVL $197.88M | Share 17.17%
```

Colour scheme per BRAND-KIT (JetBrains Mono for numbers, Space Grotesk for labels, teal gradient highlights).

### 4.2 Whale overview page — 3 donuts

On each whale page (anzen.html, avant.html, reservoir.html, etc.), below the summary cards and above the positions table, add a 3-donut row:

```
┌─ by protocol ─┐  ┌─ by token ─┐  ┌─ by market exposure ─┐
│   [donut]     │  │  [donut]   │  │     [donut]          │
│   Aave 42%    │  │ USDC 35%   │  │ Aave USDT plasma 18% │
│   Morpho 30%  │  │ RLUSD 22%  │  │ Sentora RLUSD 12%    │
│   ...         │  │ ...        │  │ ...                  │
└───────────────┘  └────────────┘  └──────────────────────┘
```

Data from `whale.secondary_exposure`. Chart.js (already loaded on index).

### 4.3 Global summary on index

Also add global view on `index.html` — top 10 "final market exposures" across all whales combined. Shows systemic risk: "$180M of tracked capital is ultimately borrowed against syrupUSDC collateral", etc.

---

## 5. Implementation phases

### Phase 1 — schema + Morpho (1 session)
- Add `position_lookthrough` table + index
- Build `src/lookthrough/morpho.js` (cleanest to start — API is public, no auth)
- Wire into `free-scans-hourly.yml` after morpho-scanner step
- Update `export.js` to attach `lookthrough` to positions
- Add modal section to `whale-common.js`
- Ship to dev, eyeball one whale (start with Reservoir since they already have a reference page)

### Phase 2 — Aave + Spark (1 session)
- `src/lookthrough/aave.js` using Aave GraphQL `market { reserves }`
- Reserves give us supply/borrow per asset but **not** per-borrower collateral. For pro-rata-by-collateral we do a **simpler lens first**: "your money sits in a pool where $X of other collateral is accepted"
- For Aave the deep lens (who borrows against what) would need subgraph borrower sampling. Mark that as Phase 4.
- Spark: same scanner, different market list

### Phase 3 — Euler + Dolomite + Compound + Fluid (1-2 sessions)
- Euler: Goldsky has account-level data, can do borrower sampling (reservoir-monitor already does this for Sentora clusters)
- Dolomite: reservoir-monitor shows it's doable with on-chain user sampling (~136 users was enough for their case)
- Compound V3: single-asset-borrow (USDC/USDT), collateral lookthrough is straightforward
- Fluid: their REST already surfaces total supply/borrow; borrower collateral from their subgraph

### Phase 4 — Aave deep borrower lookthrough (optional, later)
- Aave borrowers post multiple collaterals. To split borrows by collateral you need per-borrower data.
- Source: Aave v3 subgraph (`users { reserves { currentATokenBalance currentVariableDebt } }`)
- Sample top N borrowers, tally collateral mix, apply to whale's supply share
- This is what reservoir-monitor does for the Aave GHO case (see `brw` / `gho-mix` CSS in their HTML)

### Phase 5 — UI polish + systemic dashboard
- Global `by market` leaderboard on index
- Chain-level risk breakdown (e.g. "$200M of whale capital ultimately sits in Plasma pools")
- Alert thresholds: flag if any whale has >30% pro-rata exposure to a single exotic collateral

---

## 6. Edge cases

- **Wallet-held / YBS / Ethena cooldown:** no lookthrough. Respect existing "wallet-held has no APY" rule — extend to "wallet-held has no pool risk either." Static hold, fine.
- **Pendle PT/YT/LP:** each PT is 1:1 redeemable for SY at maturity. Lookthrough is "underlying yield source" — defer until we see value; not typical pooled risk.
- **Manual / off-chain positions** (Maple, Fasanara, private reinsurance deals): no lookthrough, opaque by design. Fine.
- **Pendle fallback rows:** already excluded from `normalization_status='canonical'`. Skip.
- **Vault-probed rows:** already dropped in export dedup. N/A.
- **Curve LP:** primary risk is token de-peg; lookthrough becomes "for each $1 LP you own $0.X of each underlying." Much simpler, worth doing for completeness.
- **Cross-source dedup:** lookthrough is scanner-tied (via `position_id`). If export.js drops a duplicate position, its lookthrough rows go with it via FK cascade.

---

## 7. Performance & rate limits

- Morpho GraphQL: no auth, soft-rate-limited. Batch vault queries; cache by `vaultAddress` across positions (same vault shared by multiple whales = 1 query).
- Aave GraphQL: same deal, one `market { reserves }` per chain per refresh cycle (shared across all Aave positions on that market).
- Euler subgraph: Goldsky free tier, keep under 10 req/sec.
- Fluid REST: public, cheap.
- Compound/Spark: direct RPC, reuse existing Alchemy keys. Batch `multicall`.
- **Refresh cadence:** every 2h (align with `free-scans-hourly`). Lookthrough is derived data, doesn't need more frequent than position data itself.
- **Fail-soft:** if a lookthrough module errors for one position, log it, keep the rest. Never block export.

---

## 8. Files to add / change

**New:**
- `src/lookthrough/morpho.js`
- `src/lookthrough/aave.js`
- `src/lookthrough/euler.js`
- `src/lookthrough/fluid.js`
- `src/lookthrough/compound.js`
- `src/lookthrough/spark.js`
- `src/lookthrough/curve.js`
- `src/build-lookthrough.js` (orchestrator)
- `docs/secondary-risk-lookthrough-plan.md` (this file)

**Modified:**
- `src/export.js` — attach `lookthrough` to each position + compute `w.secondary_exposure`
- `whale-common.js` — render lookthrough section in modal
- `whale-common.css` — market-exposure row styles (steal from reservoir-monitor's `.mex-*` classes, rewrite in our palette)
- `index.html` — add "Top Market Exposures" panel
- `.github/workflows/free-scans-hourly.yml` — add `build-lookthrough` step after all scanners
- Schema migration — add `position_lookthrough` table on DB init

---

## 9. Open questions

1. **How granular do we need per-Aave-reserve exposure?** Phase 2 gives "your USDe sits in a pool that also has $X weETH posted." Phase 4 gives "your USDe is backing $Y of loans against weETH." Start with Phase 2, decide if we need Phase 4 based on whether Saus finds the shallow lens enough.
2. **"Same market" dedup:** if two whales are in the same Morpho vault, we should only fetch that vault's markets once per refresh. Cache by `(kind, market_key)` in a per-run dict.
3. **Historical tracking:** do we want a time series of pro-rata exposures (e.g. "syrupUSDC exposure per whale over time")? Adds a write to `data/lookthrough-history/` per day. Low priority but trivial if we decide yes.
4. **Alert-worthy thresholds:** Saus to define. Candidates: concentration >30% in a single collateral, utilization >90% on a market where we have >$10M, collateral that isn't on our whitelist.

---

## 10. Deliverable acceptance

Plan is "done" when:
- Clicking any Aave/Morpho/Euler/Fluid/Compound/Spark position in any whale modal shows a "Final Market Exposure" section with ranked collaterals + USD + %
- Every whale page has 3 donuts (protocol / token / market)
- Index has a global top-10 market exposures list
- Hourly pipeline refreshes lookthrough in-line, no separate cron needed
- All dedup + "wallet-held no risk" rules still enforced
- reservoir.html looks feature-parity with reservoir-monitor.vercel.app but in our theme
