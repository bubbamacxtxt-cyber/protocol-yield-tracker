# Yield Calculation Workflow — Real Data

## API Status (tested 2026-04-08)

| Source | Coverage | Borrow APY | Supply APY | Auth |
|--------|----------|------------|------------|------|
| YBS list (`stables.json`) | 33 yield-bearing tokens | ✗ | ✓ | manual |
| DeFiLlama `/pools` | 17K pools, 539 projects | ✗ | ✓ (supply only) | free |
| Aave GraphQL `api.v3.aave.com` | All Aave v3 markets | ✓ | ✓ | free |
| Morpho GraphQL `api.morpho.org` | All Morpho markets | ✓ | ✓ | free |
| Pendle `api-v2.pendle.finance/core/v1/{chain}/markets` | 10 chains, paginate 100/page | — | ✓ (underlyingApy) | free |
| Merkl `api.merkl.xyz/v4/opportunities` | ~20 top incentivized opps | — | ✓ (bonus APR) | free |

**Critical finding**: DeFiLlama has supply APY but **NO borrow rates**. Borrow rates must come from protocol APIs directly.

---

## Position Type Workflows

### Type 1: YBS Token on Aave/Morpho (loop positions)
**Examples**: sUSDe on Aave ETH/Plasma/Mantle, syrupUSDC on Aave Base, syrupUSDT on Aave Plasma

**Formula**: `net_apy = (ybs_yield × asset_usd - borrow_apy × debt_usd) / net_usd` + merkl_bonus

| Component | Source | Example (sUSDe Aave ETH) |
|-----------|--------|--------------------------|
| ybs_yield | `stables.json` | 3.52% |
| borrow_apy | Protocol API (Aave GraphQL / Morpho GraphQL) | varies |
| merkl_bonus | Merkl API IF conditions met | ~2.11% (Ethena program) |

**Merkl conditions for Ethena program** (from live API):
- Must supply BOTH sUSDe AND USDe
- Must borrow USDC, USDT, or USDS
- Must maintain health factor < 2.5
- Campaign runs indefinitely
- Merkl bonus = `apr - nativeAprRecord.value` ≈ 2.11% on ETH, 3.46% on Mantle

**Why supply APY on sUSDe is 0% on Aave**: The yield is in the sUSDe token itself (YBS), not in the Aave protocol. Aave doesn't add extra yield on top.

### Type 2: Non-YBS Token on Aave/Morpho (simple supply)
**Examples**: USDC on Aave ETH, USDT on Aave ETH, PYUSD on Euler

**Formula**: `net_apy = (supply_apy × asset_usd - borrow_apy × debt_usd) / net_usd` + merkl_bonus

| Component | Source | Example (USDC borrow Aave ETH) |
|-----------|--------|--------------------------------|
| supply_apy | Protocol API (Aave GraphQL) | varies |
| borrow_apy | Protocol API (same API) | varies |

If supply_apy = 0 (pure stablecoin on Aave like USDC), then:
`net_apy = -(borrow_apy × debt_usd) / net_usd` — that position costs money to maintain

### Type 3: PT/Pendle Tokens
**Examples**: PT-sNUSD-4JUN2026, PT-cUSDO-28MAY2026, PT-USDG-28MAY2026

**Formula**: `net_apy = (underlying_apy × asset_usd - borrow_apy × debt_usd) / net_usd`

| Component | Source | Example (PT-sNUSD) |
|-----------|--------|-------------------|
| underlying_apy | Pendle API → `underlyingApy` | 8.42% (sNUSD) |
| borrow_apy | Protocol API | varies |

### Type 4: YT Tokens (Yield Tokens)
**Example**: YT-sNUSD-4JUN2026

**Formula**: `net_apy = ytFloatingApy × asset_usd / net_usd` (no borrow — YT has no debt)

| Component | Source | Example |
|-----------|--------|---------|
| yt_floating_apy | Pendle API → `ytFloatingApy` | varies |

### Type 5: Manual/Off-chain Positions
**Examples**: InfiniFi, Anzen, Pareto

Already have `apy_gross` and `apy_current`. Keep existing system.

### Type 6: Governance/Non-yield Tokens
**Examples**: CRV, CVX, PENDLE, ETH

APY = 0% (governance tokens, no lending yield). Flag in dashboard.

---

## Actual Position Data (verified live)

### Wallet 0x7bee...0FAb — The "weird" USDC/PYUSD position
**Aave V3 ETH**: Supply $50.6M USDC, Borrow $37.8M PYUSD, HF 1.045
**Morpho ETH**: Supply $12.4M syrupUSDC (collateral), Borrow $10.7M PYUSD (loan), HF 1.054

- syrupUSDC yield from YBS list: 4.40%
- PYUSD borrow rate from Morpho GraphQL: **3.31%** (borrowApy for market key `0xc962...`)
- PYUSD borrow rate from Aave GraphQL: need to verify

This IS a yield-generating position if syrupUSDC yield (4.40%) > borrow cost.

But wait — the Merkl data shows PYUSD has incentives:
- **Sentora PYUSD vault on Morpho**: total APR 3.79%, native 3.58% → **+0.21% Merkl bonus**
- **Sentora PYUSD vault on Euler**: total APR 4.59%, native 1.69% → **+2.90% Merkl bonus**

For our positions:
- Borrowing PYUSD means **paying** the borrow rate, not earning supply yield
- BUT if PYUSD borrow rate < syrupUSDC supply yield, the spread is profit
- Net = (4.40% × $12.4M - 3.31% × $10.7M) / $1.72M = **spread yield**

### Merkl Incentive Logic (refined)

Merkl opportunities come in two types for our use case:

**1. Supply-side bonuses** (you earn extra for supplying):
- "Supply to Sentora PYUSD vault" → add merkl to supply APY
- Match by `(protocol name + chain + token symbol)`

**2. Loop programs** (earn for meeting complex conditions):
- "Lend sUSDe and USDe on Aave (looping required)" → complex matching
- Must check ALL conditions: token set + borrow tokens + health factor
- The "total APR" shown already includes native + bonus, so:
  - `merkl_bonus = total_apr - ybs_yield` (not `total_apr - native_apr`)
  - Because for YBS tokens, the native APR is the YBS yield, not what the protocol pays

---

## Merkl Human Rules (proposed logic)

```
function getMerklBonus(wallet, position):
  opp = findMerklOpportunity(wallet, position)
  if not opp: return 0
  
  # Rule 1: Campaign must be LIVE
  if opp.status != 'LIVE': return 0
  
  # Rule 2: Token must match
  if not tokensMatch(position, opp.tokens): return 0
  
  # Rule 3: For complex programs (MULTILOG_DUTCH type)
  if opp.type == 'MULTILOG_DUTCH':
    # Check health factor condition
    if opp.description contains 'health factor below' and wallet.hf >= threshold:
      return 0
    # Check borrow token requirement
    if opp.description contains 'borrow' and not hasMatchingBorrow(wallet):
      return 0
  
  # Rule 4: Native APR already accounts for protocol yield
  # Bonus = total - native (what Merkl adds on top)
  return opp.apr - opp.nativeAprRecord.value
```

---

## Net APY Formula (final)

```
// For positions with borrow (loops):
net_apy = (apy_base × asset_usd - apy_borrow × debt_usd + apy_merkl × asset_usd) / net_usd

// For positions with supply only (no borrow):
net_apy = apy_base + apy_merkl

// For YT tokens (no borrow, floating yield):
net_apy = yt_floating_apy

// For plain borrow (rare, supply=0):
net_apy = -apy_borrow (cost to maintain)
```

---

## Implementation Plan

### Phase 1: Supply Yield (apy_base)
1. For YBS tokens → use `stables.json` (exact match or substring extract from PT names)
2. For non-yield tokens (USDC, USDT, etc.) → fetch from protocol APIs
3. For PT tokens → fetch `underlyingApy` from Pendle API
4. Store in `yield_cache` table

### Phase 2: Borrow Yield (apy_borrow)
1. Aave positions → GraphQL query for borrow rates
2. Morpho positions → GraphQL `borrowApy` from market state (already have this data!)
3. Euler/Fluid/others → DeFiLlama doesn't have borrow, check protocol APIs
4. If unknown → estimate from position spread or flag N/A

### Phase 3: Merkl Bonus (apy_merkl)
1. Fetch `/v4/opportunities` 
2. Match by protocol + chain + token
3. Apply conditional rules (HF, loan tokens, campaign status)
4. Bonus = `apr - nativeAprRecord.value`

### Phase 4: Compute + Export
1. Calculate `apy_net` per formula
2. Add columns to data.json export
3. Update dashboard HTML
4. Add to GitHub Actions workflow
