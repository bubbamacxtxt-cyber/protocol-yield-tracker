# Session Report — 2026-04-24

**Duration:** ~10 hours
**Focus:** Coverage expansion + bug fixes Saus had flagged multiple times + GitHub Actions reliability
**End state:** 96% scanner coverage of DeBank-observed yield, all 3 workflows stable, no known open blockers.

---

## Context at session start (2026-04-24 ~13:00 UTC)

Carried over from previous days:
- Scanner-first architecture in place (Aave/Morpho/Euler/Spark/Fluid/Pendle/Ethena/YO scanners)
- DeBank daily recon as the truth signal for "am I missing anything?"
- Gap report showing ~$13M uncovered across: Curve, Compound V3, Dolomite, Curvance, Gearbox, Venus, TraderJoe, ethstrat, Yuzu Money
- USDe ghost-APY bug: wallet-held USDe was showing Aave's 11% supply rate. Saus flagged this **multiple times** in prior sessions.
- Merkl bonus APY matching was nearly dead \u2014 only 2 supply + 2 borrow positions getting bonus info.
- GitHub Actions had intermittent push failures when scan + vaults workflows commit at the same time.

---

## What got built

### 1. Compound V3 (Comet) scanner — `src/compound-scanner.js` (337 LOC)

**Why:** $2.79M Midas position on Compound V3 USDC showed in DeBank recon but not in our DB.

**Architecture:**
- Hardcoded registry of 21 Comet markets across 7 chains (Ethereum, Base, Arbitrum, Polygon, Optimism, Mantle, Scroll). Markets look like `{ address, baseSymbol, underlyingAddress, chain }`.
- For each market, batched JSON-RPC for all active wallets: `balanceOf(wallet)` → supply share, `borrowBalanceOf(wallet)` → principal debt (already denominated in the base asset, no rebasing math needed).
- APY from `getSupplyRate(utilization)` / `getBorrowRate(utilization)`. Per-second model: `rate * seconds_per_year / 1e18` gives decimal APY. `getUtilization()` returns current utilization as fixed-point.
- dRPC fallback URL selection for Mantle (Alchemy Mantle app has EAPIs disabled for some markets).

**Gotchas documented:**
- Comet is the share token \u2014 balanceOf returns the rebasing supply share, which is already 1:1 valued against the underlying at any moment (unlike Aave's aTokens where you compare against `liquidityIndex`).
- `borrowBalanceOf` returns the underlying amount owed (also already post-interest), so no separate accumulator math.
- Need `decimals()` of the underlying, not the Comet itself, to convert USD values.

**Result:** Midas $2.79M at 2.45% APY captured on first run.

### 2. Curve LP + gauge scanner — `src/fetch-curve.js` (178 LOC) + `src/curve-scanner.js` (204 LOC)

**Why:** ~$3M of LP positions across Re Protocol + Midas + Yuzu (Plasma) were showing as `curve` generic rows from DeBank only, with no APY data.

**fetch-curve.js (runs in vaults workflow every 2h):**
- Iterates 10 chains × 9 Curve registry types (`main`, `crypto`, `factory`, `factory-stable-ng`, `factory-crvusd`, `factory-tricrypto`, `factory-crypto`, `factory-twocrypto`, `factory-eywa`).
- 90 total URL combos hit `https://api.curve.finance/api/getPools/{chain}/{registry}`.
- Per pool captures: `address`, `lpTokenAddress`, `gaugeAddress`, `totalSupply`, `usdTotal`, `coins[]`, `gaugeCrvApy`, `assetTypeName`.
- Writes to `curve_pools` table in SQLite, 6073 pools after dedup (composite key: `lower(lp_token)`).
- Runtime: ~90 seconds, batched.

**curve-scanner.js (runs every scan cycle):**
- No RPC calls. Reads `alchemy-token-discovery.json` (already has LP tokens via augmentation) + joins against `curve_pools` on `lp_token` OR `gauge`.
- Value = `(wallet_balance / totalSupply) × usdTotal`.
- Handles both cases: wallet holds LP token directly, OR wallet has staked into gauge and holds gauge shares.
- APY = base CRV emissions (from Curve API) + any Merkl bonus matched later.

**Result:** Re Protocol $1.41M (PENDLE-LP rkUSD/USDC), Midas $1.55M (PENDLE-LP yzUSD/USDC) on Ethereum. Plus Plasma case handled in next item.

### 3. Curve probe (generic on-chain) — addition to `src/token-discovery.js`

**Why:** Curve officially lists 12 chains. Plasma is not among them, but real Curve-style pools exist there (verified on-chain: `0x085bad2c72c8c7e3a24cb88e07d7f5c5b4b3e5ce` is a yzUSD/USDT0 pool).

**Approach:** Instead of scanning all possible pool addresses on Plasma (impossible), extract pool addresses seen in DeBank's daily recon (`data/recon/debank-wallet-positions.json`) where `protocol_id ∈ {'curve', 'plasma_curve', 'arb_curve'}`. Add these specific addresses to the Alchemy augmentation list.

**Probe logic:** For each candidate LP contract, call `get_virtual_price()` + `coins(0)` + `decimals()`. If all three succeed, it's a Curve-shaped pool. Look up token prices via our token registry + DeFiLlama for each underlying coin and compute value.

**Result:** Plasma Yuzu Money $0.80M captured. Pattern is now in place to extend to any Curve-like pool on any chain just by adding the address.

### 4. DeBank daily importer — `src/debank-import.js` (173 LOC)

**Why:** Building a proper scanner for every protocol is unbounded work. Some protocols (Dolomite with nonced sub-accounts, Curvance on Monad, Gearbox credit accounts, Venus v3 isolation markets, LFJ concentrated liquidity, ethstrat, Yuzu Money) are complex to scan and low strategic priority. DeBank already sees these positions; we just need them in our DB so dashboards are complete.

**Allowlist:** `['dolomite', 'curvance', 'monad_curvance', 'gearbox', 'monad_gearbox', 'traderjoe', 'avax_traderjoexyz', 'monad_traderjoexyz', 'venusflux', 'bsc_venusflux', 'ethstrat', 'plasma_yuzumoney', 'arb_usdai', 'usd-ai']`.

**Flow:**
1. Reads `data/recon/debank-wallet-positions.json` (written by `build-debank-recon.js` at 07:00 UTC).
2. Filters for allowlisted protocols.
3. For each position, writes a canonical row to `positions` (source_type='debank') + one `position_tokens` row per DeBank-reported token (supply/borrow role inferred from sign).
4. Uses `{chain}|{protocol}|{position_index}` as a stable key so rows update in place on the next import instead of duplicating.

**Expiry:** `purge-stale-positions.js` has a Tier 2 rule: any row with `source_type IN ('debank','manual','protocol_api')` and `scanned_at > 48h` gets purged. So if DeBank stops reporting a position for 2 days, it falls out. One missed daily recon (e.g. network issue) is absorbed.

**Wired into `.github/workflows/recon-daily.yml`** between `build-debank-recon` and `reconcile-gaps`.

**Tested locally:** $10.52M imported across 12 positions (6 protocols × multiple whales).

---

## What broke

### 1. USDe wallet holdings showing 11% APY (long-standing bug)

**Symptom:** Wallets holding USDe directly (Avant, Re Protocol, Midas) were showing the Aave ETH USDe supply rate (~11%) as their "reference" APY. This is wrong \u2014 holding USDe in a wallet earns nothing unless you actually deposit it into Aave.

**Root cause:** `src/fetch-base-apy.js` had a fallback branch at the end of the token-matching logic:
```js
// if token is in nonYieldStables and no other protocol match...
const ref = aaveRates[`eth:${symbol}`];
if (ref) return { apy: ref, source: 'aave_supply_ref' };
```
This was meant as a "give users a sense of what yield is POSSIBLE on this asset" proxy, but it was flowing through into displayed APY as if it were real yield.

**Fix (commit `9a26b01`):**
- Removed the `aave_supply_ref` fallback entirely.
- Added an explicit force-reset step at the top of the APY-apply phase:
  ```js
  db.prepare(\`
    UPDATE position_tokens SET apy_base = 0, apy_source = 'non-yield'
    WHERE position_id IN (
      SELECT id FROM positions WHERE protocol_id IN ('wallet-held', 'ethena-cooldown')
    )
  \`).run();
  ```
- This protects against any stale values from pre-fix runs and any future code path that accidentally writes a rate here.

**Verified live:** After run #50 (23:54 UTC), wallet-held USDe $1.70M shows 0% APY, ethena-cooldown USDe $23.38M shows 0% APY, Aave V3 USDe $155.37M still correctly shows 1.87%-7.88% (actual Aave rate).

### 2. Merkl bonus APYs barely working

**Symptom:** Only 4 positions out of 137 had bonus APY info. Known campaigns like Steakhouse USDT0 on Monad (+7.52%) weren't matching.

**Root causes (3 separate bugs in `fetch-merkl.js`):**

(a) Morpho supply positions store `position_index` in composite format `{wallet}|{chain}|{vault_address}|{market_id_or_noborrow}`. The matcher was comparing the ENTIRE composite string against Merkl's `identifier` (a 66-char market hash) and always getting false.

Fix: Split on `|`, take the last segment. If it looks like a market hash (0x + 64 hex) use it, otherwise skip the ID check for that row.

(b) `MORPHOSUPPLY_SINGLETOKEN` campaign type uses a TOKEN ADDRESS as its `identifier`, not a market hash. These campaigns apply to ANY Morpho position of that token across all markets. The matcher was filtering them out by requiring market-ID match.

Fix: For `campaignType === 'MORPHOSUPPLY_SINGLETOKEN'`, skip the market-ID check entirely and match on token symbol only (which was already there).

(c) Euler + Fluid matcher was only looking at `position_markets.market_id` for vault address comparison. But our scanners don't always populate the markets table \u2014 they put the vault address on `position_tokens.address`.

Fix: Fall back to `position_tokens.address` when `position_markets.market_id` is empty.

**Result:** 4 → 39 bonuses applied.

Top bonuses now live:
- +7.52% Morpho USDT0 on Monad (Steakhouse High Yield)
- +4.85% Morpho AUSD on Monad (Grove/Steakhouse) × 2
- +3.25% Morpho USDC on Monad × 2
- +3.05% Aave USDtb on ETH × 2
- +1.03% Morpho USDC borrow on Monad × 2
- +0.47% Morpho PYUSD V2

Total ~$84M of supply positions now carrying bonus APY info.

### 3. GitHub Actions push race → scan workflow failures

**Symptom:** Scan run #49 (22:56 UTC) failed on "Commit updated data" with:
```
error: you need to resolve your current index first
yield-tracker.db: needs merge
```

**Root cause:** First-pass fix earlier in session used `git stash + git rebase origin/main + git stash pop`. Rebase succeeded, but on stash-pop, the binary `yield-tracker.db` file couldn't auto-merge between "our stashed regen" and "upstream's copy post-rebase". Stash pop left the working tree in an unmerged state → `git commit` aborted.

**Fix (commits `e0d174f` + `02fff6c`):** Ditched stash/rebase. New strategy:
1. Copy regenerated outputs (`data.json`, `data/recon/*.json`, `data/source-audit.json`, `data/total-history.json`, `yield-tracker.db`) to `/tmp/scan-output/`.
2. `git checkout --` those files to discard local changes.
3. `git fetch origin main` + `git reset --hard origin/main` — fast-forward to latest upstream.
4. Copy our regenerated outputs back over the top.
5. Let git-auto-commit-action run normally.

This works because the scan pipeline **always fully regenerates** those specific files, so taking "ours" is always correct. Any upstream commits landed during our scan (from vaults workflow) are fast-forwarded in cleanly because they touch different files (`data/vaults.json`, `data/stables.json`).

**Applied to all 3 workflows:** `free-scans-hourly.yml`, `vaults.yml`, `recon-daily.yml`.

**Verified:** Run #50 at 23:40 UTC used the new logic. Detected upstream commit `02fff6c`, reset hard to it, restored outputs, committed as `c0ea823`. Clean push, no conflicts.

### 4. Upshift vault addresses were proxy addresses, not share tokens

**Symptom:** `stables.json` and `vaults.json` had addresses like `0x3299...` for Fluent USDnr. Users' wallets don't hold those \u2014 they hold the share token at `0x7ca2...`. Meant we never matched any Upshift positions even though they showed up in DeBank.

**Root cause:** August Digital's API returns the vault proxy address (the contract that routes deposits), not the actual share token that wallets hold.

**Fix:** Added `verifyVaultAddress()` in `src/fetch-vaults.js`:
```js
// For each vault, call `symbol()` (0x95d89b41). If it reverts, it's a proxy.
// If it returns a valid string, it's the real ERC-20/4626 share token.
```
Out of 151 Upshift vaults in the catalogue, 57 were proxies and got flagged `address_valid=0`. `export-vaults.js` filters those out. The 94 valid ones include the correct share token addresses that wallets actually hold.

**Also fixed in `src/fetch-stables.js`:** 13 YBS entries had DeFiLlama's `underlyingTokens` field (the asset being tokenized) instead of the pool/share address. Corrected via CoinGecko lookup for stcUSD, srUSDe, USD3, siUSD, wsrUSD, sUSDS, sfrxUSD, jrNUSD, sNUSD, cUSDO, WOUSD, reUSD. Emptied 4 where no clean CG match (sUSDa, sUSDf, dUSDC, sFRAX \u2014 user can still match these manually if positions appear).

### 5. Alchemy curated token list was blind to our YBS / vault tokens

**Symptom:** `alchemy_getTokenBalances(wallet)` returned a solid token set per wallet but was missing key yield-bearing tokens like stcUSD, siUSD, sUSDS, Upshift vault shares. These were real on-chain positions \u2014 just not in Alchemy's default curated list.

**Root cause:** Alchemy's default mode uses a ~7k curated token list per chain. New vault tokens (Upshift from 2026, Cap Protocol's stcUSD, etc.) haven't been added.

**Fix:** Two-pass approach in `src/build-alchemy-recon.js`:
1. Default `alchemy_getTokenBalances(wallet)` → base set.
2. Augmentation: for each chain, construct a list of "known YBS + vault share addresses" from `stables.json` + `vaults.json` + curated hardcoded list. Call `balanceOf(wallet)` on each address explicitly.
3. Union results into the discovery JSON.

Rate limits handled: 40-address batches per JSON-RPC call, exponential backoff on 429, 120ms sleep between wallets.

**Result:** Recovered $5M+ of positions per scan cycle that were invisible to the curated-list default.

### 6. dRPC needed for Plasma / Monad / Mantle

**Symptom:** Alchemy on our current app has no Plasma support at all, and EAPIs (enhanced APIs including `alchemy_getTokenBalances`) are disabled for Monad + some Mantle markets.

**Fix:** Signed up for dRPC, added `DRPC_API_KEY` secret to both dev and prod repos. Added URL logic in `src/build-alchemy-recon.js` to use:
- `https://lb.drpc.live/plasma/<key>` for chain 9745
- `https://lb.drpc.live/monad-mainnet/<key>` for chain 143
- `https://lb.drpc.live/mantle/<key>` for chain 5000

No enhanced `_getTokenBalances` method available on dRPC, so augmentation path only: batch `balanceOf()` against our per-chain CoinGecko token registry slice (~300 tokens per chain) plus the curated YBS/vault list. Batched JSON-RPC keeps this to a single HTTP request per chain per wallet (~350ms response).

---

## APIs used tonight (reference)

### Read-only, no auth
- **Curve API** — `https://api.curve.finance/api/getPools/{chain}/{registry}`
  - 10 chains × 9 registries = 90 URL combos
  - Returns `poolData[]` with `{address, lpTokenAddress, gaugeAddress, totalSupply, usdTotal, coins[], gaugeCrvApy, assetTypeName}`
  - Plasma NOT in supported chains list \u2014 confirmed via `https://prices.curve.finance/v1/chains`
- **DeFiLlama Yields** — `https://yields.llama.fi/pools` → 134 Compound V3 markets (used for sanity-check)
  - Already in project for fallback yields
- **Merkl Opportunities** — `https://api.merkl.xyz/v4/opportunities?chainId=X&status=LIVE&items=100&page=N`
  - Top-level array response (no wrapper object)
  - 667 live campaigns across 10 chains
  - Campaign `identifier` field: market hash for most types, TOKEN address for `MORPHOSUPPLY_SINGLETOKEN`
- **CoinGecko** — used manually for address corrections (13 stables). Our registry at `data/token-registry.json` has 17.5k tokens from a previous snapshot.

### Paid / authed
- **Alchemy** — existing key, full ETH/Base/Arbitrum/Optimism/Polygon/Sonic/Ink support. Enhanced `_getTokenBalances` + per-chain RPC URLs. Curated token list (default) needed augmentation.
- **dRPC** (NEW) — `DRPC_API_KEY=AjE4QgBkEUy-jCv1osu7eCwIxhwUQA4R8ZsGtiKh6MJI`
  - Plasma / Monad / Mantle
  - No enhanced APIs, raw RPC only, batched JSON-RPC supported
- **DeBank** — existing key, 1 call/day to `/v1/user/all_complex_protocol_list?id={wallet}` per wallet. Daily recon at 07:00 UTC. The `debank-import.js` reads the cached file, no extra API calls.

### Docs consulted
- **Dolomite** — `https://docs.dolomite.io/llms-full.txt` (bulk-fetchable docs format — good pattern). DolomiteMargin core addresses listed but `getNumMarkets()` reverts on the listed ETH address (`0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D`) \u2014 docs may be stale. Deferred to DeBank import.
- **Compound** — `https://docs.compound.finance/` confirmed Comet proxy pattern + per-second rates + rebasing share tokens + `borrowBalanceOf` returns post-interest principal.
- **August Digital (Upshift)** — `https://api.augustdigital.io/api/v1/tokenized_vault` for full catalogue. Returns vault proxy, not share token \u2014 major gotcha documented.

---

## Decisions made

1. **Don't scanner-ize every protocol.** Dolomite/Curvance/Gearbox/Venus/LFJ/ethstrat/Yuzu all have complex sub-account or concentrated-liquidity models. Building proper scanners for each is unbounded work. DeBank sees them; import daily via allowlist; expire after 48h via purge Tier 2. Revisit individually only when a protocol becomes strategically important.

2. **Wallet-held stablecoins earn 0% full stop.** No "reference rate" proxy. If it's in a wallet, it's not earning. Hardcoded reset at start of fetch-base-apy so it can't be overwritten by any later code path. Saus flagged this repeatedly \u2014 now locked down.

3. **For chains Curve's API doesn't cover (Plasma):** extract pool addresses from DeBank recon, add to augmentation list, probe generically with `get_virtual_price + coins(0) + balanceOf`. Targets the positions whales actually hold instead of trying to enumerate all pools.

4. **All 3 GitHub workflows use the same push-race guard.** Reset-hard-and-restore pattern, not stash/rebase. Binary file merge conflicts are the main failure mode, and reset-hard sidesteps them entirely by always taking "ours" for the tracked regen outputs.

5. **Upshift vault catalogue needs on-chain verification.** August Digital's API returns proxies. Our `verifyVaultAddress()` calls `symbol()` on every address and filters out reverts. 57 of 151 entries were proxies.

---

## End-state metrics

- **137 positions in DB**, net $424.51M (pre-daily-recon; imports add ~$10.5M at 07:00 UTC)
- **Scanner-owned:** $302.97M (dedicated per-protocol)
- **Token-discovery:** $117.58M (YBS + wallet-held + generic vault)
- **Curve scanner:** $2.96M
- **Generic probe:** $1.00M
- **Coverage vs DeBank-observed:** 96.0% scanner-native, 98.2% including daily DeBank import (~$8M still uncovered after daily recon, mostly dust or very niche protocols)
- **APY coverage:** 137/137 positions have an APY source assigned. 36 supply + 2 borrow positions carry bonus APY info (was 2+2).
- **Workflow reliability:** Run #50 (23:40 UTC) completed clean with the new push-race guard.

---

## Open items for next session

| Priority | Item | Notes |
|---|---|---|
| P1 | Verify daily DeBank import at 07:00 UTC runs cleanly on CI | Local test was clean, but want to see it live before trusting it |
| P2 | Convex LP scanner | Makina ~$1.29M; generic pattern similar to Curve (pool + gauge + rewards) |
| P2 | yo-protocol real APY | Currently uses `aave_supply_ref` for USDC \u2014 approximately correct since yoUSD deploys into lending, but should switch to yoUSD's own reported APY via their public API |
| P3 | Dolomite on-chain scanner | Docs appear stale for ETH deployment. Their npm package `@dolomite-exchange/dolomite-margin` might be the right path. Or find a subgraph URL. DeBank import covers it meanwhile. |
| P3 | Aave looping bonus (3.75% sUSDe+USDe) | No whale currently qualifies (need BOTH tokens supplied on same Aave market + USDC/USDT borrow + HF<2.5). Matcher is ready if one shows up. |
| P3 | Euler sub-vaults: eRLUSD-7, ePYUSD-6, bbqAUSDturbo, bbqUSDCturbo | "Still missing APY" in fetch-base-apy output. Positions captured; APY resolution from Euler indexer isn't matching for sub-vaults. Low value: ~$1M total. |
| P4 | fUSDnr non-4626 share case | Upshift fUSDnr doesn't implement `asset()` or `symbol()` canonically. Left as probe-miss. |

---

## Commits landed (dev repo)

| SHA | Title | Files |
|---|---|---|
| `16d69d4` | token-discovery: ERC-4626 probe + address-first YBS + better error reporting | src/token-discovery.js, src/build-alchemy-recon.js |
| `1900977` | dRPC fallback for Mantle / Plasma / Monad | src/build-alchemy-recon.js |
| `3521fc4` | Fix YBS + vault addresses; curated-list augmentation | data/stables.json, data/vaults.json, src/fetch-stables.js, src/build-alchemy-recon.js |
| `811882a` | feat: Curve LP + gauge scanner | src/fetch-curve.js, src/curve-scanner.js, workflows |
| `5c7cda0` | Catch Curve positions on chains Curve's API doesn't cover (Plasma) | src/token-discovery.js |
| `d004ce0` | feat: Compound V3 (Comet) scanner | src/compound-scanner.js, workflows, scripts/purge-stale-positions.js |
| `43b1b31` | feat: daily DeBank import for protocols without scanners | src/debank-import.js, .github/workflows/recon-daily.yml, scripts/purge-stale-positions.js |
| `9a26b01` | fix: USDe/USDC wallet holdings shouldn't earn yield; expand Merkl bonus APY coverage | src/fetch-base-apy.js, src/fetch-merkl.js |
| `e0d174f` | fix: scan workflow push-race resolution | .github/workflows/free-scans-hourly.yml |
| `02fff6c` | fix: apply push-race guard to vaults.yml and recon-daily.yml | .github/workflows/vaults.yml, .github/workflows/recon-daily.yml |

Plus automated `Hourly free scans` and `Auto-update vault + stables data` commits from CI runs throughout the session.

---

## Files created / modified (summary)

**Created:**
- `src/compound-scanner.js` (337 LOC) — new scanner
- `src/curve-scanner.js` (204 LOC) — new scanner
- `src/fetch-curve.js` (178 LOC) — vault-workflow catalogue fetcher
- `src/debank-import.js` (173 LOC) — daily protocol importer
- `docs/session-report-2026-04-24.md` — this file

**Modified (significant):**
- `src/fetch-base-apy.js` — USDe reset + removed aave_supply_ref fallback (+36 LOC net)
- `src/fetch-merkl.js` — 3 bug fixes in Morpho/Euler/Fluid matcher (+42 LOC net)
- `src/fetch-vaults.js` — on-chain address verification (+242 LOC net, including Upshift catalogue changes)
- `src/fetch-stables.js` — address fixes + verification (+100 LOC net)
- `src/token-discovery.js` — ERC-4626 probe, Curve probe, address-first YBS (+288 LOC net)
- `src/build-alchemy-recon.js` — dRPC support, curated-list augmentation, per-chain RPC URLs (+414 LOC net)
- `scripts/purge-stale-positions.js` — added debank-import rows to Tier 2 48h window (+114 LOC net)
- `.github/workflows/free-scans-hourly.yml` — Curve + Compound scanners, push-race guard (+53 LOC net)
- `.github/workflows/vaults.yml` — fetch-curve step, push-race guard (+33 LOC net)
- `.github/workflows/recon-daily.yml` — debank-import step, push-race guard (+33 LOC net)

**Data files regenerated:**
- `data.json`, `data/source-audit.json`, `data/total-history.json`, `data/stables.json`, `data/vaults.json`
- `data/recon/alchemy-token-discovery.json`, `data/recon/canonical-token-matches.json`, `data/recon/debank-wallet-positions.json`, `data/recon/debank-wallet-summary.json`, `data/recon/gap-report.json`, `data/recon/wallet-inventory.json`
- `yield-tracker.db` (1.87 MB → 4.78 MB after schema expansions for curve_pools + position source tracking)

---

## Workflow schedules (confirmed as of 2026-04-25 00:00 UTC)

| Workflow | Cron (UTC) | Next after session close | Purpose |
|---|---|---|---|
| Protocol Scans (2h) | `15 */2 * * *` | 00:15, 02:15, 04:15, 06:15, ... | Full scanner pipeline, enrichment, Merkl, export |
| Update Vault Data | `30 */2 * * *` | 00:30, 02:30, 04:30, 06:30, ... | Upshift/IPOR vaults, YBS APYs, Curve pool catalogue |
| Daily DeBank Recon | `0 7 * * *` | 07:00 UTC | DeBank API call, import non-scanner protocols, gap report |

All 3 workflows now have push-race guards and will fast-forward over concurrent commits rather than failing.
