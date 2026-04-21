# Protocol Yield Tracker — Recovery Plan

**Date:** 2026-04-21
**Status:** Ready for execution

---

## Current State (Verified)

| Component | Status | Key Finding |
|-----------|--------|-------------|
| DB | ✅ Clean | 139 positions, integrity OK |
| Aave scanner | ⚠️ Partial | Missing Ink ($3.5M) + Plasma ($15.8M) positions |
| Morpho scanner | ❌ Broken | Not finding Avant supply positions (only borrow fragments) |
| Euler scanner | ❌ Broken | All positions = $0 in DB |
| Alchemy discovery | ❌ Weak | Only 37 scans, no token value resolution |
| DeBank recon | ⚠️ Over-gated | $10M thresholds blocking sidechains |
| Export | ⚠️ Fragile | 5 hack-fixes today, needs clean rebuild |

---

## Critical Data Quality Issues

1. **`value_usd` missing from ALL positions** — Every position has `asset_usd`/`debt_usd` but no `value_usd`. Frontend shows NaN.
2. **Morpho negative net USD: -$75.16M** — Borrow-heavy positions or merge bug.
3. **Euler scanner shows $0** — 18 positions found but token values not populating.
4. **Ethena 100% fallback** — $94M exposure, no direct scanner.

---

## Phase 1: Fix Lane 1 — DeBank Recon Gating (30 min)

**Problem:** $10M thresholds on Mantle/Ink/Plasma/Base blocking legitimate positions.

**Actions:**
- Remove `allowedAaveChainFromRecon()` hard thresholds in `src/aave-scanner.js`
- Keep only $50K universal threshold
- Run Aave scanner for ALL active wallet+chain pairs from recon
- Re-run and verify Ink + Plasma positions appear

**Files:** `src/aave-scanner.js` lines 45-58

---

## Phase 2: Fix Lane 2 — Alchemy Token Discovery (2-3 hrs)

**Problem:** Only scans 37 wallet-chains, doesn't resolve token values, misses Ethena and other >$50K holdings.

**Actions:**
- Expand coverage: Scan ALL whale wallets (not just DeBank-active ones)
- Add token metadata resolution: Call `alchemy_getTokenMetadata` for each token address
- Add USD value calculation: Use CoinGecko or Alchemy price API for token prices
- $50K threshold: Only output tokens with >$50K value
- Match against expanded registry:
  - YBS tokens (sUSDe, sUSDS, stcUSD, etc.)
  - Vault tokens (steakUSDC, etc.)
  - Major stablecoins (USDC, USDT, DAI)
- Leave unmatched tokens as "wallet-held" with raw data
- Write positions directly to DB as `wallet-held` source type

**New file:** `src/token-discovery.js` (replacement for `build-alchemy-recon.js`)

**APIs needed:**
- Alchemy: `alchemy_getTokenBalances`, `alchemy_getTokenMetadata`
- CoinGecko: `/simple/token_price/{platform}` for USD prices

---

## Phase 3: Fix Lane 3 — Protocol Scanners (4-6 hrs)

### 3A: Aave Scanner (1 hr)

**Problem:** Missing Ink ($3.5M) and Plasma ($15.8M) positions.

**Root cause:** Scanner runs but returns empty for those chains → positions not in DB.

**Actions:**
- Debug Aave GraphQL for Ink chain (pool `0x5362dBb1e601AbF2a150D1999Be54a4d308f4F6e`)
- Debug Aave GraphQL for Plasma chain (pool `0x925a2A7214Ed92428B5b1B090F80b25700095e12`)
- Test with actual wallet addresses:
  - `0x920EefBCf1f5756109952E6Ff6dA1Cab950C64d7` (Ink)
  - `0x3207363359Ca0c11D11073aD48301E8c958B7910` (Plasma)
  - `0xc46831...` (Plasma)
- Verify response format matches expected `userSupplies` / `userBorrows` structure
- Fix if API endpoint or pool address is wrong

### 3B: Morpho Scanner (2 hrs)

**Problem:** Avant wallet `0x7bee8d` has $3.6M Morpho on ETH but DB shows only -$26.8M borrow.

**Root cause:** Earn positions (supply) not being found, only borrow positions.

**Actions:**
- Test Morpho REST API directly for `0x7bee8d37fba61a6251a08b957d502c56e2a50fab`
- Call: `GET /positions/earn?userAddress=0x7bee8d...&chainIds=1`
- Verify response has vault positions
- If API returns empty → check if wallet uses different address or vault IDs
- Fix earn position parsing if response format changed

### 3C: Euler Scanner (1-2 hrs)

**Problem:** All Euler positions = $0 in DB.

**Root cause:** Scanner finds vault balances but doesn't write token values.

**Actions:**
- Test Euler indexer: `https://indexer.euler.finance/v2/vault/list?chainId=1&take=1000`
- Test Alchemy balance for known Euler vaults
- Verify token price lookup (vault share → underlying value)
- Fix value calculation in `upsertVaultPosition()`

### 3D: Pendle Scanner (Future)

**Problem:** Still V1, basic.

**Action:** Deprioritize — focus on Aave/Morpho/Euler first.

---

## Phase 4: Fix Lane 4 — Clean Export (2 hrs)

**Problem:** 5 hack-fixes today, fragile dedup logic, wrong suppressions.

**Actions:**
- Remove Ethena-specific suppression (already done, verify)
- Remove synthetic token hack — fix at source (Lane 2/3)
- Simplify dedup: Only collapse exact duplicates (same wallet+chain+protocol+token address)
- Remove borrow-only suppression — fix Morpho scanner instead
- Add `p.value_usd = p.net_usd` for frontend compatibility
- Add validation gates:
  - No negative net without explicit borrow
  - Supply tokens must match asset_usd
  - Borrow tokens must match debt_usd
- Clean separation: Lane 4 should ONLY format, not decide what to keep

---

## Phase 5: Validation & QA (2 hrs)

**Actions:**
- Run full pipeline on dev
- Compare export vs DeBank gap report
- Target: <5% gap for wallets >$1M
- Spot-check each whale:
  - Avant: should show 8 positions (not 4)
  - Yuzu: check ETH positions
  - Reservoir: check Base positions
- Commit clean state
- Push to dev, verify frontend

---

## Execution Order

| Phase | Time | Priority |
|-------|------|----------|
| 1: Remove DeBank thresholds | 30 min | P0 |
| 3A: Fix Aave Ink/Plasma | 1 hr | P0 |
| 3B: Fix Morpho earn | 2 hrs | P0 |
| 3C: Fix Euler values | 2 hrs | P1 |
| 2: Token discovery rewrite | 3 hrs | P1 |
| 4: Clean export | 2 hrs | P1 |
| 5: Validation | 2 hrs | P2 |

**Total:** ~1.5 days focused work

---

## Immediate Next Steps (Tomorrow)

1. Test Aave GraphQL for Ink + Plasma with actual Avant wallets
2. Test Morpho API for `0x7bee8d` earn positions
3. Fix `value_usd` in export.js (one-liner)

---

## Key Files

| File | Purpose |
|------|---------|
| `src/aave-scanner.js` | Remove thresholds, debug Ink/Plasma |
| `src/morpho-scanner.js` | Fix earn position parsing |
| `src/euler-scanner.js` | Fix value calculation |
| `src/token-discovery.js` | NEW — replacement for build-alchemy-recon.js |
| `src/export.js` | Clean rebuild |
| `src/validate.js` | Add validation gates |
