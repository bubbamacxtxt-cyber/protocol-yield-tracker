# Protocol Scanner Setup Report
## 2026-04-17

---

## Executive Summary

Built three protocol scanners (Morpho, Aave, Euler) that call protocol APIs directly instead of relying on DeBank position data. DeBank is now only used for initial wallet/chain discovery. All position details (supply tokens, borrow tokens, APY) come from protocol APIs.

---

## Architecture

### Before (broken)
```
DeBank → positions (no tokens, no APY) → "enrich" with protocol APIs
Problem: DeBank positions have no supply/borrow token data
```

### After (working)
```
DeBank → wallet/chain discovery only
Protocol APIs → actual positions with tokens and APY
Merge via dedup in export.js
```

---

## 1. Morpho Scanner

**Status:** Working (was already implemented)

**API:** REST API on `app.morpho.org/api`
- Borrow positions: `GET /api/positions/borrow?userAddress=0x...&chainIds=1,8453,...&limit=500`
- Earn positions: `GET /api/positions/earn?userAddress=0x...&chainIds=...`

**What it provides:**
- Market positions (supply/borrow) with health factor, collateral/borrow amounts
- Full market data (loan/collateral assets, chainId)
- Direct position creation, no DeBank dependency

**Gotchas:**
- `userByAddress` GraphQL returns empty for most wallets - must use REST API
- REST API has x-apollo-operation-name header requirement (CSRF protection)
- Chain IDs: 1, 8453, 42161, 137, 130, 747474, 999, 10, 143, 988, 480

---

## 2. Aave v3 Scanner

**Status:** Built 2026-04-17

**API:** GraphQL at `https://api.v3.aave.com/graphql`

**Query format:**
```graphql
{
  userSupplies(request: { user: "0x...", markets: [{ address: "0x...", chainId: 1 }] }) {
    currency { symbol }
    balance { usd }
    apy { value }
    isCollateral
  }
  userBorrows(request: { user: "0x...", markets: [{ address: "0x...", chainId: 1 }] }) {
    currency { symbol }
    debt { usd }
    apy { value }
  }
  userMarketState(request: { user: "0x...", market: "0x...", chainId: 1 }) {
    healthFactor
  }
}
```

**Pool addresses (chainId → pool):**
| Chain | ChainId | Pool Address |
|-------|---------|--------------|
| Ethereum | 1 | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` |
| Base | 8453 | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| Plasma | 9745 | `0x925a2A7214Ed92428B5b1B090F80b25700095e12` |
| Mantle | 5000 | `0x458F293454fE0d67EC0655f3672301301DD51422` |
| Arbitrum | 42161 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Polygon | 137 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |

**Scans only:** Reservoir wallets (not all whales)

**Gotchas:**
- `amount` field requires subfields - don't use it, use `usd` only
- `userMarketState` returns healthFactor as string (e.g., "1.157...")
- GraphQL errors if query syntax wrong - test with curl first

---

## 3. Euler v2 Scanner

**Status:** Built 2026-04-17

**API:** Goldsky subgraph at `https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn`

**Query for vault balances:**
```graphql
{
  trackingVaultBalances(where: { account: "0x..." }) {
    vault { id }
    balance
    debt
  }
}
```

**Query for vault info:**
```graphql
{
  eulerVault(id: "0x...") {
    id name symbol asset { id symbol decimals }
  }
}
```

**Known vaults (Reservoir):**
| Vault | Underlying |
|-------|------------|
| `0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2` | eRLUSD → RLUSD |
| `0xba98fc35c9dfd69178ad5dce9fa29c64554783b5` | ePYUSD → PYUSD |

**APY enrichment:** DeFiLlama `https://yields.llama.fi/pools`
- Filter: `project=euler-v2, chain=Ethereum`
- Returns `apyBase` and `apyReward` (both annualized percentages)
- 24 Euler vaults on DeFiLlama

**Gotchas:**
- `balance` is hex string (BigInt), convert with `BigInt(b.balance)`
- Goldsky subgraph may be stale (hourly updates)
- `vault` field in response is string, not object - handle both formats
- Don't use `.toLowerCase()` inside GraphQL query string
- Shares are raw (68 trillion shares = $68M - divide by 1e18 for human-readable)

---

## 4. Export & Dedup

**Problem:** Scanner positions and DeBank positions have different identifiers:
- DeBank: `position_index` = underlying token address
- Scanner: `position_index` = vault address

**Solution:** vault→underlying mapping in export.js dedup:
```javascript
const vaultToUnderlying = {
  '0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2': '0x8292bb45bf1ee4d140127049757c2e0ff06317ed',
  '0xba98fc35c9dfd69178ad5dce9fa29c64554783b5': '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
};
```

**Supply token USD values:** Scanner positions have $0 value. After dedup merge, distribute `asset_usd` equally among supply tokens that have $0.

---

## 5. Bugs Fixed

### A. APY overwrite bugs
- `apy_base` was being overwritten by weighted token average (null for DeBank positions)
- `bonus_supply` was being overwritten by token bonus sum (null for positions without tokens)
- **Fix:** Only set from tokens if value > 0 AND existing value is null

### B. GraphQL query errors
- `amount` field needs subfields - removed from queries
- `.toLowerCase()` inside query string invalid - moved to JS

### C. Vault/underlying mismatch
- Scanner creates position per vault, DeBank creates per underlying
- **Fix:** vault→underlying mapping for dedup key

---

## 6. Current Reservoir Positions

| Chain | Protocol | Supply Tokens | Net APY |
|-------|----------|--------------|---------|
| eth | Euler | eRLUSD-7 $68.7M | 5.95% |
| eth | Euler | ePYUSD-6 $45.9M | 6.00% |
| eth | Morpho | RLUSD $34M | 502.3% |
| eth | Morpho | PYUSD $30.5M | 503.9% |
| eth | Morpho | USDC $9M | 455.6% |
| eth | Morpho | rUSD $0.1M | 594.6% |
| plasma | Aave V3 | GHO $10M | 145.6% |
| mnt | Aave V3 | GHO $2M | 111.5% |
| monad | Morpho | AUSD $3M | 692.2% |

---

## 7. Workflow

GitHub Actions runs:
1. `fetch.js` - DeBank wallet discovery
2. `aave-scanner.js` - Aave positions from API
3. `euler-scanner.js` - Euler positions from subgraph
4. `enrich-markets.js` - Market metadata enrichment
5. `fetch-base-apy.js` - Base APY rates
6. `fetch-merkl.js` - Merkl incentives
7. `fix-morpho-tokens.js` - Morpho label fixes
8. `export.js` - Export to data.json

---

## Files Changed

- `src/aave-scanner.js` - New multi-chain Aave scanner
- `src/euler-scanner.js` - New Euler scanner  
- `src/export.js` - Dedup fixes, APY protection, vault mapping
- `.github/workflows/update.yml` - Added scanner steps
