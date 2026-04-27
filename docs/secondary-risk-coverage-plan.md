# Secondary Risk — 100% Coverage Plan

**Status:** Draft v2 (supersedes Phase-4 section of `secondary-risk-lookthrough-plan.md`)
**Created:** 2026-04-27
**Goal:** Every tracked dollar has a known secondary-risk decomposition or an explicit "opaque" label. No bodges, no guesses, no silent gaps.

---

## 1. The problem with the original plan

The v1 plan stopped at "lookthrough for lending markets" (Aave / Morpho / Euler / Fluid / Compound / Spark / Curve). That covers 50% of tracked value. The other 50% is:

| Class | Value | Current plan coverage |
|---|---|---|
| Off-chain / opaque (Maple, Fasanara, reinsurance, Deal IDs) | **$186.4M** | Zero |
| YBS tokens (yoUSD, Cap stcUSD, Ethena, InfiniFi, Sky, Yuzu, USDai, yzUSDUSDT0) | **$135.2M** | Zero |
| Wallet holds | **$23.4M** | Zero |
| Single-venue (Dolomite, Gearbox, Curvance, Venus Flux, LFJ, Adaptive Frontier, RockawayX, STRATEGY) | **$49.0M** | Zero |
| Pendle PT/YT/LP | **$3.9M** | Zero |
| Curve LP | **$3.0M** | Shallow only |
| Isolated Morpho Blue / Fluid vault markets | **$11.3M** | Counted but trivial |

**$408M of $757M is not properly decomposed** by v1. That's unacceptable for a secondary-risk dashboard.

v2 fixes this by replacing "lookthrough" (lending-only) with a single generalized abstraction: **Exposure Decomposition**.

---

## 2. Core abstraction: Exposure Decomposition

Every position has a **decomposition tree**:

```
Position $100M yoUSD
└── Vault: yoUSD (Base)
    ├── 40% → Aave V3 USDC supply           $40M  [RECURSE]
    │       └── Shared pool of $X reserves → pro-rata exposure to weETH/cbBTC/...
    ├── 30% → Morpho vault "X"              $30M  [RECURSE]
    │       └── Markets: syrupUSDC/RLUSD, weETH/RLUSD, ...
    ├── 20% → Pendle PT-sUSDe               $20M  [RECURSE]
    │       └── Underlying: sUSDe → Ethena backing mix
    └── 10% → USDC wallet                   $10M  [LEAF: stable hold]
```

Every leaf is one of:
- `primary_asset` — USDC, USDT, DAI, ETH, BTC. The end of the chain.
- `pool_share` — pro-rata claim on a lending pool's other reserves (Aave/Spark/Euler loan vault).
- `opaque_offchain` — explicitly labeled "we don't know" (Maple, Fasanara, reinsurance).
- `unknown` — we failed to decompose. **This must be zero at 100% coverage.**

Each node tracks: `{ kind, venue, asset, usd, pct_of_parent, depth, source, confidence, evidence_url }`.

This unifies the v1 lookthrough table with YBS backing, off-chain attestations, and single-venue pools. One table, one recursive resolver, one rendering pattern.

---

## 3. Coverage strategy per class

### 3.1 Lending pools (shared borrower collateral) — Aave / Spark
**$113M. Deep version.**

The shallow lens ("other assets in the pool") is a bodge. We do the **proper** version from day one.

- For each Aave market we already have reserves via GraphQL (`market { reserves { currency, aTokenBalance, vTokenBalance, supplyInfo { apy } } }`).
- We add a **borrower-side query**: Aave v3 subgraph has `users { reserves { currentATokenBalance currentVariableDebt, reserve { symbol } } }` per market.
- **Not sampling.** We pull **all borrowers with debt >$100K** (typically 100–500 per market). Subgraph query with `where: { currentVariableDebt_gt: "0" }` + pagination. This is bounded; largest Aave markets have ~1,000 meaningful borrowers.
- Aggregate: for each borrower, split their collateral mix pro-rata to their debt in our loan asset. Tally across all borrowers → "X% of loan asset demand is backed by collateral Y."
- Cache at `(market, loan_asset)` granularity. One query per (market, loan_asset) per refresh, shared across all whales in the same market.
- **Maintainability:** the subgraph schema is stable. One helper `fetchAaveBorrowerMix(market, loanAsset, chainId)`.

Spark uses the same code with a different subgraph URL.

### 3.2 MetaMorpho vaults — Morpho
**$144.9M. Already solved by v1.** GraphQL `vaultByAddress { state { allocation { market { collateralAsset loanAsset } assets } } }`. Keep as-is.

### 3.3 Euler clusters
**$86.7M. Already solved by v1** via Goldsky + on-chain borrower cross-referencing (same as reservoir-monitor). Keep as-is.

### 3.4 Isolated Morpho Blue / Fluid vault markets
**$11.3M. Trivial.** These are single-collateral / single-loan by design. Lookthrough = one row, the collateral. Already captured by scanner output — just normalize into the decomposition table.

### 3.5 YBS tokens — yoUSD, Cap stcUSD, Ethena, InfiniFi, Sky, Yuzu, USDai, yzUSDUSDT0
**$135.2M. New work.**

Every YBS has a **reserve contract** or **vault** we can read on-chain to get its composition. No bodge, no guesses.

| Token | Backing decomposition source |
|---|---|
| yoUSD | `yoUSD.sol` on Base. Public API: `https://app.yo.xyz/api/vaults/yousd` returns the strategy split (Aave / Morpho / Pendle). Verify on-chain: read each strategy adapter's balance. |
| Cap stcUSD | Cap Finance vault. `https://api.cap.app/vaults/stcUSD` (or their subgraph). Reads the delegator list + how much is delegated to each operator. |
| ethena USDe/sUSDe | On-chain reserve contract — `ReserveFund` + `StakingRewardsDistributor`. Ethena publishes attestations (chaoslabs, LlamaRisk) monthly; API: `https://app.ethena.fi/api/solvency` and `https://app.ethena.fi/api/reserve`. Mix = perps hedge + stables + tbills. |
| InfiniFi (iUSD, fUSDnr) | Their app has a backing page. API: `https://www.infinifi.xyz/api/reserves`. Each position routes to a venue (Morpho, Spark, Aave) with a fixed allocation. |
| Sky (sUSDS) | MakerDAO/Sky PSM + DSR. Read from `VAT` contract on-chain, or Sky's public dashboard API. Backing = tbills + ETH collateral + other RWAs. |
| USDai | `api.usdai.io` (or their subgraph) — the strategy list. |
| Yuzu | Their site already uses the reservoir-monitor pattern. API: `https://yuzu-repository.vercel.app/api/data` or similar. |
| yzUSDUSDT0 | Yuzu product. Same source. |

**Pattern:**
- One adapter per YBS: `src/ybs-backing/<name>.js`. Exports `async function fetchBacking(tokenAddress): Promise<BackingRow[]>`.
- Each `BackingRow` is `{ venue, asset, usd, pct, recurse_into: <positionShape | null> }`.
- `recurse_into` lets us recurse: e.g. yoUSD → Aave USDC → `{ kind: "aave", wallet: <yoUSD_strategy_addr>, chain: "base" }` → scanner runs on it → lookthrough runs on that → full tree.
- **Fallback:** if API is down, use last-known composition from DB (`ybs_backing` table) with an `as_of` timestamp. Never silently skip.
- **Confidence:** `high` when on-chain verified, `medium` when only API, `low` when stale >72h.

### 3.6 Curve LP
**$3.0M. Easy.** LP = token basket. Pool composition is already in `curve_pools` (we have `src/curve-scanner.js`). For each LP position: `pool.coins.map(c => c.balance / pool.totalSupply × user.lpBalance)` gives per-token exposure in USD. If one of the underlyings is itself a YBS (e.g. sUSDai), recurse.

### 3.7 Pendle PT/YT/LP
**$3.9M. Solvable.**

- **PT:** redeems 1:1 to SY at maturity. Decompose to the SY's underlying. e.g. `PT-sUSDE-7MAY26 → sUSDE → Ethena backing mix`.
- **YT:** exposure is to yield of SY, not principal. Decompose to SY's backing with a note `{ yield_only: true }`. Render as "yield claim on X" not "principal claim on X."
- **LP:** PT + SY pair. Split by pool reserves like Curve LP.

Pendle's subgraph has SY metadata; we already have `fetch-pendle.js` style helpers.

### 3.8 Single-venue protocols — Dolomite, Gearbox, Venus Flux, Curvance, LFJ, Adaptive Frontier, RockawayX, STRATEGY, usd-ai
**$49M. The largest maintenance risk.**

This is where v1 would have left gaps. Solution: **one adapter per venue, stored in a plugin-style registry.**

```
src/venue-lookthrough/
  dolomite.js
  gearbox.js
  venus-flux.js
  curvance.js
  lfj.js
  adaptive-frontier.js
  rockawayx.js
  strategy.js          // specific to "STRATEGY" protocol name from DeBank
  usd-ai.js
  _registry.js         // maps protocol_name → adapter
```

Each adapter exports a standard interface:
```js
module.exports = {
  protocol_names: ['Dolomite'],
  confidence: 'high' | 'medium',
  async compute(position, context) {
    // return [{ venue, asset, collateral, usd, pct, source }]
    // or throw { kind: 'opaque', reason: '...' } if intentionally undecomposable
  },
  references: ['https://docs.dolomite.io/...', 'https://api.dolomite.io/...'],
};
```

The orchestrator:
1. Looks up `position.protocol_canonical` in the registry.
2. If adapter exists → run it. Store result.
3. If no adapter → write one `unknown` row with protocol name + "TODO: add adapter". **This is the maintenance signal.** A new venue appears → we see it on the dashboard as red `unknown`, we write an adapter, it goes green.
4. Adapters are unit-testable (fixture a position → expect decomposition rows).

**Maintenance contract:** the dashboard surfaces `unknown` value prominently. You can't ignore an uncovered venue because it's in your face. New venue onboarding = write one small file + test.

### 3.9 Off-chain / opaque — Maple Institutional, Fasanara, Private Reinsurance Deals, Deal IDs
**$186.4M. Honest "opaque" labeling + attestation where available.**

- Maple: they publish per-pool `poolDelegate` composition and exposure reports. API: `https://api.maple.finance/v2/pools`. Pool = basket of loans to named borrowers. Each loan has a borrower name, principal, status. Decompose to `{ borrower_name, usd, status: healthy|defaulted|delinquent }`. Maple provides this; it's first-party.
- Fasanara (mGLOBAL GDADF, Genesis Fund, Digital): private fund. Fasanara publishes monthly investor letters. We ingest the **stated composition** from their investor portal (manual entry, source = "fasanara-monthly-2026-04"). Decomp = fund's published strategy mix.
- Private Reinsurance Deals: these are literally private. Mark `opaque_offchain` with counterparty + `source: "manual"` + `attestation_url: <link>`. No pretense.
- Deal IDs (MMZ*, HLF*, BYZ*, ICM*, SPR*, SPS*): these look like specific reinsurance notes. Mark `opaque_offchain` with CUSIP-style identifier + issuer + maturity + notional. Provide a "Why can't we decompose this?" tooltip.

**Rule:** every opaque row shows a **stated category** (e.g. "reinsurance", "credit fund", "trading strategy") + **counterparty** + **attestation source** (monthly letter, deal confirmation, etc.). Transparent-about-opacity is the right answer, not a bodge.

### 3.10 Wallet holds
**$23.4M.** Decompose = the token itself. USDC → `{ primary_asset, USDC, $X, 100% }`. If the held token is a YBS (e.g. sUSDe held in wallet, not locked), recurse into its backing. Already have the YBS adapters from 3.5.

---

## 4. Unified data model

Replace the `position_lookthrough` table from v1 with:

```sql
CREATE TABLE IF NOT EXISTS exposure_decomposition (
  id INTEGER PRIMARY KEY,
  position_id INTEGER REFERENCES positions(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES exposure_decomposition(id) ON DELETE CASCADE,  -- for recursive trees
  depth INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
    -- 'primary_asset' | 'pool_share' | 'market_exposure' | 'ybs_strategy'
    -- | 'lp_underlying' | 'pendle_underlying' | 'opaque_offchain' | 'unknown'
  venue TEXT,                   -- 'Aave V3', 'Morpho/Sentora-RLUSD', 'Maple/High-Yield-Fund'
  venue_address TEXT,
  chain TEXT,
  asset_symbol TEXT,
  asset_address TEXT,
  usd REAL NOT NULL,
  pct_of_parent REAL,           -- 0..100
  pct_of_root REAL,             -- 0..100, denormalized for easy render
  utilization REAL,             -- when kind=pool_share or market_exposure
  adapter TEXT NOT NULL,        -- 'aave', 'morpho', 'yousd', 'maple', 'manual', 'unknown'
  source TEXT NOT NULL,         -- 'onchain', 'subgraph', 'protocol-api', 'manual', 'cached'
  confidence TEXT NOT NULL,     -- 'high', 'medium', 'low'
  as_of TEXT,                   -- ISO timestamp of the data snapshot
  attestation_url TEXT,         -- for opaque_offchain
  evidence_json TEXT,           -- raw blob for debugging / audit
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(position_id, parent_id, adapter, venue_address, asset_address)
);
CREATE INDEX idx_expdec_position ON exposure_decomposition(position_id);
CREATE INDEX idx_expdec_parent ON exposure_decomposition(parent_id);
CREATE INDEX idx_expdec_kind_confidence ON exposure_decomposition(kind, confidence);
```

One table for all protocols. Recursive tree via `parent_id`. Unknown coverage → one row with `kind='unknown'`, shows up red in UI.

---

## 5. Code layout (maintenance-first)

```
src/
  exposure/
    index.js                       # orchestrator: for each position, dispatch to adapter
    registry.js                    # maps protocol_canonical → adapter + confidence + docs URL
    recurse.js                     # tree builder + pct_of_root computation + loop-guard
    adapters/
      _base.js                     # shared helpers: priceLookup, on-chain read, caching
      # Lending pools (deep lookthrough via borrower mix)
      aave.js                      # incl Spark (same shape, different markets)
      morpho-vault.js              # MetaMorpho (deposit-side markets)
      morpho-blue.js               # direct Blue market (isolated)
      euler.js                     # EVK clusters
      fluid.js                     # Fluid vaults
      compound.js                  # V3 Comet
      # LPs
      curve-lp.js
      pendle.js                    # PT + YT + LP
      # YBS
      yousd.js
      cap-stcusd.js
      ethena.js                    # USDe + sUSDe
      infinifi.js                  # iUSD + fUSDnr
      sky.js                       # sUSDS
      usd-ai.js
      yuzu.js                      # Yuzu + yzUSDUSDT0
      # Single-venue
      dolomite.js
      gearbox.js
      venus-flux.js
      curvance.js
      lfj.js
      adaptive-frontier.js
      rockawayx.js
      debank-strategy.js           # the generic "STRATEGY" bucket
      # Off-chain
      maple.js
      fasanara.js                  # all three Fasanara products
      reinsurance-deal.js          # MMZ/HLF/BYZ/ICM/SPR/SPS pattern
      # Wallet / primary
      wallet.js                    # resolves to primary_asset or recurses into YBS
      primary.js                   # terminal leaves (USDC, ETH, etc.)
      # Fallback
      unknown.js                   # emits one `unknown` row per undecomposed position
    caching/
      ybs-backing-cache.js         # backs API failures with last-known snapshot
      borrower-mix-cache.js        # Aave/Spark borrower aggregation cache (TTL 6h)
  build-exposure.js                # top-level: loads positions, runs orchestrator, writes table
```

Test fixtures at `test/exposure/<adapter>.test.js` with pinned JSON snapshots from protocol APIs.

---

## 6. Coverage audit — always-on

The most important piece for "easy to maintain":

### 6.1 Coverage report

A new daily job `src/audit-exposure.js` that emits `data/exposure-audit.json`:
```json
{
  "total_value": 757084673,
  "decomposed_value": 757084673,
  "coverage_pct": 100.0,
  "by_class": {
    "high_confidence": 620000000,
    "medium_confidence": 130000000,
    "low_confidence_or_stale": 7000000,
    "opaque_offchain": 186000000,
    "unknown": 0
  },
  "stale_ybs": [
    { "token": "yoUSD", "last_fresh": "2026-04-20", "age_hours": 186, "usd": 22910000 }
  ],
  "unknown_positions": [],
  "adapter_health": {
    "aave": { "last_run": "...", "positions_handled": 17, "errors": 0 },
    "morpho-vault": { ... },
    ...
  }
}
```

Rendered on an admin page `/audit.html`. If `coverage_pct < 99.5%` or `unknown_positions.length > 0` or `stale_ybs` has entries, it goes red.

### 6.2 CI gate

`free-scans-hourly.yml` adds a job `verify-coverage` that fails the workflow if:
- `coverage_pct < 99.5%`
- any `unknown_positions` with usd > $100K
- any adapter with `errors > 3` in the last run

Failing the workflow → GitHub emails you → you add the missing adapter. **This is the maintenance forcing function.**

---

## 7. UI (v2)

### 7.1 Position modal — decomposition tree

Replace the v1 "final market exposure" block with a collapsible tree:

```
Position: yoUSD vault (Base)       $22.91M
└─ Underlying strategies (yoUSD protocol API, as_of 3h ago)  high
   ├─ Aave V3 USDC (Base)          $9.16M   40%
   │  └─ Shared pool exposure (Aave borrower mix, 147 borrowers)  high
   │     ├─ weETH collateral backing     $3.66M   40% of pro-rata
   │     ├─ cbBTC collateral backing     $2.75M   30%
   │     ├─ wstETH collateral backing    $1.83M   20%
   │     └─ USDC (unborrowed)            $916K    10%
   ├─ Morpho "Gauntlet USDC Prime"  $6.87M   30%
   │  └─ 4 markets: [expand to see syrupUSDC/USDC, weETH/USDC, ...]
   ├─ Pendle PT-sUSDe              $4.58M   20%
   │  └─ sUSDe → Ethena backing
   │     ├─ Perps hedge short ETH    $2.06M   45%
   │     ├─ T-bills                  $1.83M   40%
   │     └─ Stables                  $687K    15%
   └─ USDC wallet                   $2.29M   10%   [primary]
```

Chart.js donut at the top: "by final asset exposure" — shows what the $22.91M is **actually** exposed to after full recursion.

### 7.2 Whale page donuts (v1 kept)

Still 3 donuts (by protocol / by token / by market) but now computed from **root-level aggregates** of the decomposition tree. Much more accurate than v1 which only covered 50% of value.

Plus one new donut: **by confidence** — "how much of this whale's capital do we actually understand?" Shows opaque/unknown as a slice.

### 7.3 Global systemic panel (index.html)

- Top 20 final-asset exposures across all whales, ranked.
- Total opaque value with dropdown by counterparty (Maple, Fasanara, individual deal IDs).
- Coverage % gauge + "last adapter added" timestamp.

### 7.4 `/audit.html` — operator view

Lists every protocol the tracker has ever seen, its adapter status (green / yellow / red), last success, last error, stale warnings. One page to see if the tracker is still accurate.

---

## 8. Rollout (real, not phased-and-forgotten)

Each phase ships a **measurable coverage improvement**, independently useful.

| Phase | Work | New coverage | New UI |
|---|---|---|---|
| **0** | Exposure schema, orchestrator, unknown/primary/wallet adapters, audit system, `/audit.html` | Baseline 0% decomposed, 100% classified | audit page live |
| **1** | Morpho vault + Morpho Blue + Curve LP + Fluid adapters | +$159M decomposed | Position modal tree (MVP) |
| **2** | Aave + Spark deep (borrower mix via subgraph) + Euler (reuse reservoir-monitor pattern) | +$199M = $358M total | Whale donuts v2 |
| **3** | All YBS adapters (yoUSD, Cap, Ethena, InfiniFi, Sky, USDai, Yuzu) + Pendle | +$139M = $497M | Recursive tree in modal |
| **4** | Single-venue adapters (Dolomite, Gearbox, Venus, Curvance, LFJ, Adaptive Frontier, RockawayX, STRATEGY) | +$49M = $546M | adapter health on /audit |
| **5** | Off-chain adapters (Maple, Fasanara, reinsurance deal loader) | +$186M = $732M | opaque section styled, counterparty breakdown |
| **6** | Wallet hold resolution + primary asset terminals + stragglers (usd-ai, yzUSDUSDT0) | +$25M = $757M = 100% | global systemic panel |
| **7** | Alerting (concentration > X%, stale data > Y hrs, coverage dips), CI gate | — | Discord/email webhook |

Each phase ends with `coverage_pct` on the audit page going up. If you don't want to do a phase, the unknown rows in `exposure_decomposition` + `/audit.html` make it **visible** that you haven't done it — not hidden.

---

## 9. Why this is maintainable

1. **One abstraction (decomposition) for everything.** No special-case code paths for "lending vs YBS vs off-chain." Same table, same render, same audit.
2. **Adapter pattern with a registry.** New protocol = one file + one registry line. Old protocol change = edit one file. Nothing cross-cuts.
3. **Explicit `unknown` kind.** You can't silently miss a venue. It shows up on `/audit.html` as red.
4. **CI coverage gate.** Coverage regression fails the build. Stale YBS data beyond 72h fails the build.
5. **Confidence tiers, not boolean "works/broken."** A degraded adapter (API 500s, falling back to cache) stays useful and just downgrades to `medium`.
6. **Fixture tests.** Each adapter has a snapshot of the real API response. If the external API shape changes, tests fail loudly, not silently.
7. **Documentation per adapter.** Every adapter file has a header block with: source URLs, data shape, last verified date, known quirks. Living docs live next to the code.

---

## 10. What we're *not* doing (explicit scope control)

- **Not** building real-time WebSocket feeds. 2h refresh is enough for a risk dashboard.
- **Not** inferring borrower intent or predicting liquidations beyond what utilization + HF already tell us.
- **Not** trying to decompose truly opaque structures (private reinsurance). We **label** them.
- **Not** replacing DeBank import for single-venue detection. It still feeds `positions`; we just attach adapters after.
- **Not** touching the existing position scanners. Exposure decomposition is a **new layer on top.** Original scanners stay untouched → no regression risk.
- **Not** breaking v1 plan. The `position_lookthrough` table from v1 never gets written — we go straight to `exposure_decomposition` as the unified model.

---

## 11. Concrete definition of done

100% coverage = all of:

1. `coverage_pct >= 99.5%` on the audit page for 7 consecutive days
2. `unknown_positions.length === 0` for any position with usd > $50K
3. Every YBS has a `ybs_backing_<name>.js` adapter with a unit test and a fixture, freshness < 24h
4. Every opaque off-chain position has a `counterparty` + `attestation_url` (even if that URL is an S3 PDF of a monthly letter)
5. `/audit.html` is live, green, and linked from index
6. CI coverage gate is enabled on main

Signed off when Saus can load the site, click any position, and see the **full tree down to primary assets** or an **honest opaque label** — no silent gaps.
