# DeFi Protocol API Reference

Documentation for the APIs used to fetch protocol data in this project.

## Table of Contents
- [Aave v3](#aave-v3) - GraphQL API
- [Morpho](#morpho) - GraphQL API  
- [Euler](#euler) - Goldsky Subgraph
- [Fluid](#fluid) - REST API

---

## Aave v3

**Type:** GraphQL  
**Base URL:** `https://api.v3.aave.com/graphql`  
**Auth:** None required

### Available Queries

```graphql
# Get all supported chains
query Chains {
  chains { name chainId }
}

# Get market/reserve data
query Markets($request: MarketsRequest!) {
  markets(request: $request) {
    name
    chain { name chainId }
    reserves {
      underlyingToken { symbol address decimals }
      aToken { address }
      vToken { address }
      liquidityRate
      variableBorrowRate
      utilizationRate
    }
  }
}

# Get user positions
query UserPosition($address: String!, $chainId: Int!) {
  userByAddress(address: $address, chainId: $chainId) {
    userSupplies {
      currency { symbol address }
      balance { amount { value } usd }
      apy { formatted }
      isCollateral
    }
    userBorrows {
      currency { symbol address }
      debt { amount { value } usd }
      apy { formatted }
    }
    userMarketState {
      healthFactor
      totalCollateralBase
      totalDebtBase
    }
  }
}

# Get specific market info
query MarketById($marketId: String!, $chainId: Int!) {
  marketById(marketId: $marketId, chainId: $chainId) {
    name
    loanAsset { symbol address }
    collateralAsset { symbol address }
  }
}
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `chainId` | Int | Chain ID (1=ETH, 8453=Base, 42161=Arbitrum, etc.) |
| `address` | String | User wallet address |
| `marketId` | String | Pool address |

### Key Pool Addresses

| Chain | Chain ID | Pool Address |
|-------|----------|--------------|
| Ethereum | 1 | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` |
| Base | 8453 | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| Arbitrum | 42161 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Plasma | 9745 | `0x925a2A7214Ed92428B5b1B090F80b25700095e12` |
| Mantle | 5000 | `0x458F293454fE0d67EC0655f3672301301DD51422` |
| BSC | 56 | `0x6807dc923806fE8Fd134338EABCA509979a7e0cB` |
| Sonic | 146 | `0x5362dBb1e601AbF2a150D1999Be54a4d308f4F6e` |
| Mantle | 5000 | `0x458F293454fE0d67EC0655f3672301301DD51422` |

### Example: Fetch all ETH reserves

```javascript
const https = require('https');

function postJSON(url, body) {
  return new Promise((res, rej) => {
    const bodyStr = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    });
    req.on('error', rej);
    req.write(bodyStr);
    req.end();
  });
}

async function getAaveReserves(chainId = 1) {
  const data = await postJSON('https://api.v3.aave.com/graphql', {
    query: `{ markets(request: {chainIds: [${chainId}]}) {
      name
      reserves {
        underlyingToken { symbol address decimals }
        aToken { address }
        vToken { address }
        liquidityRate
        variableBorrowRate
      }
    }}`
  });
  return data.data?.markets || [];
}
```

### Notes

- `apy.formatted` returns String with 2 decimal places (e.g., `"3.06"`)
- `balance.usd` is a direct String value
- `chainId` parameter is Int, not enum
- Rate values are in ray format (divide by 1e27 for percentage)
- vToken addresses are the variable debt token addresses

---

## Morpho

**Type:** GraphQL  
**Base URL:** `https://api.morpho.org/graphql`  
**Auth:** None required

### Available Queries

```graphql
# Get user positions (direct markets + vaults)
query UserPositions($address: String!, $chainId: Int!) {
  userByAddress(address: $address, chainId: $chainId) {
    # Direct market positions
    marketPositions {
      market {
        uniqueKey
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        state { borrowApy supplyApy }
      }
      supplyAssetsUsd
      borrowAssetsUsd
      supplyAssets
      borrowAssets
    }
    # Vault positions
    vaultPositions {
      vault {
        address
        name
        asset { symbol address decimals }
        state { apy }
      }
      assetsUsd
      assets
    }
  }
}

# Get market info
query MarketInfo($uniqueKey: String!, $chainId: Int!) {
  marketByUniqueKey(uniqueKey: $uniqueKey, chainId: $chainId) {
    loanAsset { symbol address }
    collateralAsset { symbol address }
    state { borrowApy supplyApy }
  }
}
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `chainId` | Int | Chain ID (1=ETH, 42161=Arbitrum, 8453=Base, etc.) |
| `address` | String | User wallet address |
| `uniqueKey` | String | Market unique key (format: `0x...chainId`) |

### Market Unique Key Format

Morpho uses composite keys: `{market_address}{chainId}`

Example: `0x1eae3e76c63a2e3cd8a1a2d0a81a5d07d07ec6e41` on chain 1 = `0x1eae3e76c63a2e3cd8a1a2d0a81a5d07d07ec6e41000000000000000000000001`

### Example: Fetch user positions

```javascript
async function getMorphoPositions(address, chainId = 1) {
  const data = await postJSON('https://api.morpho.org/graphql', {
    query: `query { userByAddress(address: "${address.toLowerCase()}", chainId: ${chainId}) {
      marketPositions {
        market {
          uniqueKey
          loanAsset { symbol address decimals }
          collateralAsset { symbol address decimals }
          state { borrowApy supplyApy }
        }
        supplyAssetsUsd
        borrowAssetsUsd
      }
      vaultPositions {
        vault { address name asset { symbol decimals } state { apy } }
        assetsUsd
      }
    }}`
  });
  return data.data?.userByAddress;
}
```

### Notes

- APY values are decimals (0.0399 = 3.99%), multiply by 100 for display
- `uniqueKey` in campaign data = market ID (used for bonus matching)
- Vault positions are separate from market positions
- `health_rate` is in `detail.health_rate` (undocumented field in DeBank)

---

## Euler

**Type:** GraphQL (Goldsky Subgraph)  
**Base URL:** Varies by chain (see table below)  
**Auth:** None required

### Subgraph Endpoints

| Chain | Chain ID | Vaults | Endpoint |
|-------|----------|--------|----------|
| Ethereum | 1 | 500 | `euler-v2-mainnet` |
| Base | 8453 | 258 | `euler-v2-base` |
| Sonic | 146 | 174 | `euler-v2-sonic` |
| Arbitrum | 42161 | 116 | `euler-v2-arbitrum` |
| Berachain | 80085 | 59 | `euler-v2-berachain` |
| Monad | 143 | 98 | `euler-v2-monad` |
| Optimism | 10 | 1 | `euler-v2-optimism` |

Base URL pattern:
```
https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/{endpoint}/latest/gn
```
### Available Queries

```graphql
# Get all vaults
query Vaults($first: Int!) {
  eulerVaults(first: $first) {
    id          # Vault address
    name        # Vault name
    symbol      # Vault symbol (e.g., "eUSDC-64")
    asset       # Underlying token address
  }
}

# Get vault by account
query VaultByAccount($account: Bytes!) {
  vaultByAccounts(where: {account: $account}) {
    vault { id name symbol asset }
  }
}

# Get user balances
query AccountBalances($account: Bytes!) {
  accountAggrVaults(where: {account: $account}) {
    account { id }
    vault { id name symbol asset }
    balance
  }
}

# Get vault status
query VaultStatus($vaultId: Bytes!) {
  vaultStatuses(where: {vault: $vaultId}, first: 1) {
    supply
    borrow
    totalSupplyAssets
    totalBorrowAssets
  }
}
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `first` | Int | Number of results (max 1000) |
| `account` | Bytes | User wallet address (0x...) |
| `vaultId` | Bytes | Vault contract address |

### Example: Get vaults for a token

```javascript
async function getEulerVaultsForToken(tokenAddress) {
  const url = 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn';
  const data = await postJSON(url, {
    query: `{ eulerVaults(first: 500) { id name symbol asset } }`
  });
  
  const vaults = data.data?.eulerVaults || [];
  return vaults.filter(v => 
    v.asset?.toLowerCase() === tokenAddress.toLowerCase()
  );
}
```

### Notes

- Each vault has a unique `id` (address) - this is the Merkl campaign identifier
- Multiple vaults can exist for the same underlying asset (e.g., 100+ USDC vaults)
- Vault symbols are like `eUSDC-64`, `ePYUSD-4`, etc.
- `asset` field is the underlying token address for matching positions

---

## Fluid

**Type:** REST API  
**Base URLs:**
- Liquidity tokens: `https://api.fluid.instadapp.io/{chainId}/liquidity/tokens`
- Vaults: `https://api.fluid.instadapp.io/v2/{chainId}/vaults`
- Vault APR history: `https://api.fluid.instadapp.io/v2/{chainId}/vaults/{address}/apr-history`

**Auth:** None required

### Supported Chains

| Chain | Chain ID | Vaults | Tokens |
|-------|----------|--------|--------|
| Ethereum | 1 | 122 | 33 |
| Arbitrum | 42161 | 62 | 17 |
| Base | 8453 | 36 | 19 |
| Polygon | 137 | 20 | 11 |
| Plasma | 9745 | 35 | 14 |
| BSC | 56 | 34 | 10 |

### Endpoints

#### 1. Get Liquidity Tokens
```
GET https://api.fluid.instadapp.io/{chainId}/liquidity/tokens
```

Response:
```json
[
  {
    "address": "0x...",
    "name": "f(x) USD",
    "symbol": "fxUSD",
    "decimals": 18,
    "price": "0.997",
    "chainId": "1",
    "logoUrl": "https://...",
    "coingeckoId": "f-x-protocol-fxusd"
  }
]
```

#### 2. Get Vaults
```
GET https://api.fluid.instadapp.io/v2/{chainId}/vaults
```

Response:
```json
[
  {
    "id": "1",
    "type": "1",
    "address": "0xeAbBfca72F8a8bf14C4ac59e69ECB2eB69F0811C",
    "supplyToken": {
      "token0": {
        "address": "0xeeee...",
        "name": "ETH",
        "symbol": "ETH",
        "decimals": 18,
        "price": "2242.91",
        "chainId": "1"
      },
      "token1": { "address": "0x0000..." }
    },
    "borrowToken": {
      "token0": {
        "address": "0xb8ce...",
        "symbol": "USDT0",
        "decimals": 18
      },
      "token1": { "address": "0x0000..." }
    }
  }
]
```

#### 3. Vault APR History
```
GET https://api.fluid.instadapp.io/v2/{chainId}/vaults/{address}/apr-history?start={ISO}&end={ISO}
```

### Example: Get vaults for matching

```javascript
async function getFluidVaults(chainId) {
  const resp = await fetch(
    `https://api.fluid.instadapp.io/v2/${chainId}/vaults`
  );
  const vaults = await resp.json();
  
  // Build lookup: vault address → { supply, borrow }
  return vaults.reduce((map, v) => {
    map[v.address.toLowerCase()] = {
      address: v.address.toLowerCase(),
      supplyAddr: v.supplyToken?.token0?.address?.toLowerCase(),
      supplySymbol: v.supplyToken?.token0?.symbol,
      borrowAddr: v.borrowToken?.token0?.address?.toLowerCase(),
      borrowSymbol: v.borrowToken?.token0?.symbol,
    };
    return map;
  }, {});
}

// Match a position to a vault
function matchFluidPosition(position, vaults) {
  const supplyAddr = position.supply_address?.toLowerCase();
  const borrowAddr = position.borrow_address?.toLowerCase();
  
  return Object.values(vaults).find(v =>
    v.supplyAddr === supplyAddr &&
    (borrowAddr ? v.borrowAddr === borrowAddr : true)
  );
}
```

### Notes

- Vault address is the Merkl campaign identifier
- Some positions are single-token (no borrow) - match supply only
- `token1` with all-zero address means single-token position
- Fluid has both lending (supply/borrow) and liquidity positions

---

## Market Enrichment

All protocols are enriched via `src/enrich-markets.js` which runs before the Merkl bonus calculation.

### How It Works

1. **Aave:** Queries GraphQL for reserves, matches by vToken address in position_index
2. **Euler:** Queries Goldsky subgraph, matches by vault address in position_index
3. **Fluid:** Queries REST API, matches by supply/borrow token pair
4. **Morpho:** Uses position_index directly (is the market ID)

### Database Schema

```sql
CREATE TABLE position_markets (
  position_id INTEGER PRIMARY KEY REFERENCES positions(id),
  protocol TEXT,       -- 'Aave V3', 'Morpho', 'Euler', 'Fluid'
  chain TEXT,          -- 'eth', 'arb', 'plasma', etc.
  market_id TEXT,      -- Vault/market address
  market_name TEXT,    -- Human-readable name
  underlying_token TEXT,
  source TEXT          -- How matched: 'reserve-match', 'vault-address', 'vault-match'
);
```

### Running Enrichment

```bash
# Manual run
node src/enrich-markets.js

# Part of daily pipeline
node src/enrich-markets.js   # 1. Enrich
node src/fetch-merkl.js      # 2. Match bonuses
node src/export.js           # 3. Export data
```

---

## Merkl Bonus Matching

`src/fetch-merkl.js` fetches Merkl campaigns and matches them to positions.

### Matching Rules by Protocol

| Protocol | Matching Field | Campaign Identifier |
|----------|---------------|---------------------|
| Morpho | market_id (position_index) | Market uniqueKey |
| Aave | market_name (contains "Horizon", "Core", etc.) | Campaign title |
| Euler | market_id (vault address) | Vault address |
| Fluid | market_id (vault address) | Vault address |

### Campaign Structure

```json
{
  "id": "...",
  "name": "Lend USDe and sUSDe on Aave",
  "type": "MULTILOG_DUTCH",
  "action": "LEND",
  "identifier": "0x...",
  "tokens": [
    { "symbol": "USDe", "address": "0x...", "decimals": 18 }
  ],
  "rewardTokens": [
    { "symbol": "MERKL", "address": "0x...", "amount": "..." }
  ],
  "apr": "3.06",
  "explorerUrl": "https://...",
  "tags": ["aave", "aave-v3"]
}
```
