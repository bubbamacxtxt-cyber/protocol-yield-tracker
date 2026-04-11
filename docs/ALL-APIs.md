# Complete API Reference

All APIs used across the Protocol Yield Tracker, Yield Portal, and Aave Yield Dashboard projects.

---

## Table of Contents

- [DeBank Cloud API](#debank-cloud-api) - Position scanning
- [Aave v3 GraphQL](#aave-v3) - Lending reserves
- [Morpho GraphQL](#morpho) - Lending positions
- [Euler Goldsky Subgraph](#euler) - Vault positions
- [Fluid REST API](#fluid) - Lending vaults
- [Merkl API](#merkl-api) - Incentive bonuses
- [InfiniFi API](#infinifi-api) - RWA positions
- [Pareto API](#pareto-api) - sUSP vault
- [Anzen API](#anzen-api) - USDz RWA
- [Pendle API](#pendle-api) - Yield tokens
- [CoinGecko API](#coingecko-api) - Token prices
- [1inch Token List](#1inch-token-list) - Token registry
- [DeFiLlama APIs](#defillama-apis) - Yields + stablecoins
- [Portals API](#portals-api) - Multi-protocol yields
- [August Digital API](#august-digital-api) - Tokenized vaults

---

## DeBank Cloud API

**Base URL:** `https://pro-openapi.debank.com`  
**Auth:** API key in header  
**Cost:** $200 for 1M units  

### Endpoints

| Endpoint | Method | Units | Use |
|----------|--------|-------|-----|
| `/v1/user/used_chain_list` | GET | 2 | Which chains wallet is active on |
| `/v1/user/chain_balance` | GET | ~1 | Total USD value on a chain |
| `/v1/user/complex_protocol_list` | GET | 10 | All protocol positions on a chain |
| `/v1/user/token_list` | GET | ~1 | All tokens in wallet |
| `/v1/user/nft_list` | GET | ~1 | NFT holdings |

### Parameters

```
GET /v1/user/used_chain_list?id={address}
GET /v1/user/chain_balance?id={address}&chain_id={chain}
GET /v1/user/complex_protocol_list?id={address}&chain_id={chain}
```

### Example

```javascript
const DEBANK_KEY = process.env.DEBANK_API_KEY;

async function getPositions(address, chainId) {
  const resp = await fetch(
    `https://pro-openapi.debank.com/v1/user/complex_protocol_list?id=${address}&chain_id=${chainId}`,
    { headers: { 'AccessKey': DEBANK_KEY } }
  );
  return resp.json();
}
```

### Response Structure

```json
{
  "id": "aave-v3",
  "name": "Aave V3",
  "chain": "eth",
  "total_asset_usd": "256500000",
  "portfolio_item_list": [
    {
      "detail": {
        "supply_token_list": [{ "symbol": "USDe", "amount": 100000, "price": 1 }],
        "borrow_token_list": [{ "symbol": "USDC", "amount": 50000, "price": 1 }],
        "health_rate": "1.03"
      },
      "position_index": "0x..."
    }
  ]
}
```

---

## Aave v3

**Type:** GraphQL  
**URL:** `https://api.v3.aave.com/graphql`  
**Auth:** None  

### Queries

```graphql
# All reserves on a chain
query {
  markets(request: {chainIds: [1]}) {
    name
    reserves {
      underlyingToken { symbol address decimals }
      aToken { address }
      vToken { address }
      liquidityRate
      variableBorrowRate
    }
  }
}

# User positions
query {
  userByAddress(address: "0x...", chainId: 1) {
    userSupplies {
      currency { symbol address }
      balance { usd apy { formatted } }
    }
    userBorrows {
      currency { symbol address }
      debt { usd apy { formatted } }
    }
    userMarketState { healthFactor }
  }
}
```

### Pool Addresses

| Chain | Chain ID | Pool |
|-------|----------|------|
| Ethereum | 1 | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` |
| Base | 8453 | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| Arbitrum | 42161 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Plasma | 9745 | `0x925a2A7214Ed92428B5b1B090F80b25700095e12` |
| Mantle | 5000 | `0x458F293454fE0d67EC0655f3672301301DD51422` |
| BSC | 56 | `0x6807dc923806fE8Fd134338EABCA509979a7e0cB` |
| Sonic | 146 | `0x5362dBb1e601AbF2a150D1999Be54a4d308f4F6e` |

### Notes

- APY returns as formatted string (e.g., `"3.06"`)
- vToken address used for market identification
- Markets have sub-pools: Core, Horizon, EtherFi, Lido

---

## Morpho

**Type:** GraphQL  
**URL:** `https://api.morpho.org/graphql`  
**Auth:** None  

### Queries

```graphql
query {
  userByAddress(address: "0x...", chainId: 1) {
    marketPositions {
      market {
        uniqueKey
        loanAsset { symbol address }
        collateralAsset { symbol address }
        state { borrowApy supplyApy }
      }
      supplyAssetsUsd
      borrowAssetsUsd
    }
    vaultPositions {
      vault { address name asset { symbol } state { apy } }
      assetsUsd
    }
  }
}
```

### Market ID Format

`uniqueKey` = `{market_address}{chainId_padded_to_32_bytes}`

For matching: `position_index` contains the uniqueKey directly.

### Notes

- APY values are decimals (0.0399 = 3.99%)
- `uniqueKey` is used as Merkl campaign identifier

---

## Euler

**Type:** GraphQL (Goldsky Subgraph)  
**Base URL:** `https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/{subgraph}/latest/gn`  
**Auth:** None  

### Subgraph Endpoints

| Chain | Chain ID | Subgraph | Vaults |
|-------|----------|----------|--------|
| Ethereum | 1 | `euler-v2-mainnet` | 500 |
| Base | 8453 | `euler-v2-base` | 258 |
| Sonic | 146 | `euler-v2-sonic` | 174 |
| Arbitrum | 42161 | `euler-v2-arbitrum` | 116 |
| Berachain | 80085 | `euler-v2-berachain` | 59 |
| Monad | 143 | `euler-v2-monad` | 98 |
| Optimism | 10 | `euler-v2-optimism` | 1 |

### Query

```graphql
query {
  eulerVaults(first: 500) {
    id          # Vault address = Merkl identifier
    name
    symbol      # e.g., "eUSDC-64"
    asset       # Underlying token address
  }
}
```

### Notes

- Multiple vaults can exist for same underlying (e.g., 100+ USDC vaults)
- Vault `id` is the Merkl campaign identifier

---

## Fluid

**Type:** REST  
**Base URL:** `https://api.fluid.instadapp.io`  
**Auth:** None  

### Endpoints

| Endpoint | Chains | Use |
|----------|--------|-----|
| `/{chainId}/liquidity/tokens` | 1, 42161, 8453, 137, 9745, 56 | Token list |
| `/v2/{chainId}/vaults` | All above | Vault list with supply/borrow |
| `/v2/{chainId}/vaults/{addr}/apr-history` | All above | Historical APR |

### Supported Chains

| Chain | Chain ID | Vaults | Tokens |
|-------|----------|--------|--------|
| Ethereum | 1 | 122 | 33 |
| Arbitrum | 42161 | 62 | 17 |
| Base | 8453 | 36 | 19 |
| Polygon | 137 | 20 | 11 |
| Plasma | 9745 | 35 | 14 |
| BSC | 56 | 34 | 10 |

### Vault Response

```json
{
  "address": "0xeAbBfca72F8a8bf14C4ac59e69ECB2eB69F0811C",
  "supplyToken": {
    "token0": { "address": "0x...", "symbol": "ETH", "decimals": 18 }
  },
  "borrowToken": {
    "token0": { "address": "0x...", "symbol": "USDT0", "decimals": 18 }
  }
}
```

### Notes

- Vault address is the Merkl campaign identifier
- `token0.address = 0x0000...` means no borrow (single-token position)

---

## Merkl API

**Base URL:** `https://api.merkl.xyz/v4`  
**Auth:** None  

### Endpoints

| Endpoint | Use |
|----------|-----|
| `/opportunities?chainIds={ids}&status=LIVE` | All live campaigns |
| `/tokens?chainIds={ids}` | Reward tokens info |

### Chain IDs

```
1=eth, 42161=arb, 8453=base, 9745=plasma, 5000=mnt,
146=sonic, 56=bsc, 143=monad, 999=hyper, 57073=ink
```

### Response Structure

```json
{
  "id": "...",
  "name": "Lend USDe on Aave",
  "type": "MULTILOG_DUTCH",
  "action": "LEND",
  "identifier": "0x...",
  "apr": "3.06",
  "tokens": [{ "symbol": "USDe", "address": "0x...", "decimals": 18 }],
  "rewardTokens": [{ "symbol": "MERKL", "amount": "..." }],
  "explorerUrl": "https://app.merkl.xyz/opportunity/...",
  "tags": ["aave", "aave-v3"]
}
```

---

## InfiniFi API

**Base URL:** 
- ETH: `https://eth-api.infinifi.xyz/api/protocol/data`
- Plasma: `https://plasma-api.infinifi.xyz/api/protocol/data`

**Auth:** None

### Query

```javascript
const resp = await fetch('https://eth-api.infinifi.xyz/api/protocol/data');
const data = await resp.json();

// Response contains:
// - yield_sources: array of underlying strategies
// - vault_tvl: total value locked
// - apy: current APY
```

### Mapping

```javascript
const YIELD_SOURCE_MAP = {
  'morpho-steakUSDCinfinifi': 'morpho',
  'morpho-steakUSDTinfinifi': 'morpho',
  'tokemak-auto-infinifiUSD': 'tokemak',
};
```

---

## Pareto API

**Base URL:** `https://app.pareto.credit/api/v1`  
**Auth:** None  
**On-chain:** `ParetoDollarQueue` at `0xA7780086ab732C110E9E71950B9Fb3cb2ea50D89`

### Endpoints

| Endpoint | Use |
|----------|-----|
| `/vault-blocks` | Historical vault data |
| `/vault-blocks?limit=1` | Latest vault info |

### On-chain Reads (ethers.js)

```javascript
const queue = new ethers.Contract(
  '0xA7780086ab732C110E9E71950B9Fb3cb2ea50D89',
  ['function getAPY() view returns (uint256)',
   'function getTotalDeposits() view returns (uint256)'].join('\n'),
  provider
);

const apy = await queue.getAPY();
const deposits = await queue.getTotalDeposits();
```

---

## Anzen API

**Base URL:** `https://rwa-api.anzen.finance/collaterals`  
**Auth:** None  
**On-chain:** USDz token varies by chain

### Query

```javascript
const resp = await fetch('https://rwa-api.anzen.finance/collaterals?page=1');
const data = await resp.json();

// Returns collateral data with yield info
```

---

## Pendle API

**Base URL:** `https://api-v2.pendle.finance/core/v1/`  
**Auth:** None

### Endpoints

| Endpoint | Use |
|----------|-----|
| `/markets?chain_id={id}` | All markets |
| `/tokens?chain_id={id}` | Token info |

### Key Data

- Market addresses for yield tokenization
- PT (Principal Token) and YT (Yield Token) prices
- Underlying yield rates

---

## CoinGecko API

**Base URL:** `https://api.coingecko.com/api/v3`  
**Auth:** None (free) / Pro API key  
**Rate Limit:** ~20 requests/min (free)

### Endpoints

| Endpoint | Use |
|----------|-----|
| `/coins/{id}` | Token price + metadata |
| `/simple/price?ids={ids}&vs_currencies=usd` | Batch price lookup |
| `/coins/{id}/contract/{address}` | Token by contract address |

### Chain Mapping

```javascript
const CHAIN_MAP = {
  eth: 'ethereum', arb: 'arbitrum-one', base: 'base',
  poly: 'polygon-pos', bsc: 'binance-smart-chain',
  avax: 'avalanche', op: 'optimistic-ethereum',
};
```

---

## 1inch Token List

**Base URL:** `https://tokens.1inch.io`  
**Auth:** None

### Endpoints

| Endpoint | Use |
|----------|-----|
| `/v6.0/{chainId}` | All tokens on chain |
| `/v6.0/1` | ETH tokens (~2,570) |

### Response

```json
[
  {
    "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "symbol": "USDC",
    "decimals": 6,
    "name": "USD Coin",
    "logoURI": "https://..."
  }
]
```

### Supported Chains

1=ETH, 10=Optimism, 56=BSC, 100=xDai, 137=Polygon, 250=Fantom, 42161=Arbitrum, 43114=Avalanche

---

## DeFiLlama APIs

**Base URL:** `https://yields.llama.fi`  
**Auth:** None  
**Rate Limit:** Generous (be nice)

### Endpoints

| Endpoint | Use |
|----------|-----|
| `/pools` | All yield pools across protocols |
| `/stablecoins` | Stablecoin market caps |
| `/protocols` | Protocol info |
| `/chart/{pool}` | Historical APY for a pool |

### Stablecoins Endpoint

```javascript
const resp = await fetch('https://stablecoins.llama.fi/stablecoins');
const data = await resp.json();

// Returns: { peggedAssets: [{ name, symbol, chains, circulating }] }
```

---

## Portals API

**Base URL:** `https://api.portals.fi/v2`  
**Auth:** Bearer token  
**Budget:** 50,000 calls/month  

### API Key

```
e9302cf2-58c8-4275-a533-ed0342b78fff
```

### Endpoints

| Endpoint | Use | Auth |
|----------|-----|------|
| `/tokens?chains={ids}&minTvl=1000000` | All tokens with TVL | Bearer |
| `/tokens?platforms={protocol}` | Protocol-specific tokens | Bearer |
| `/account?owner={address}` | Wallet positions | Bearer |

### Headers

```
Authorization: Bearer e9302cf2-58c8-4275-a533-ed0342b78fff
```

---

## August Digital API

**Base URL:** `https://api.augustdigital.io/api/v1/tokenized_vault/{address}`  
**Auth:** None

### Query

```javascript
const resp = await fetch(`https://api.augustdigital.io/api/v1/tokenized_vault/${address}`);
const data = await resp.json();

// Returns: { historical_apy: { '7': 0.052, '30': 0.048, '90': 0.051 } }
```

### Known Vaults

Used for yield-bearing stablecoin lookups in `fetch-stables.js`.

---

## RPC Endpoints (On-chain)

Used for ethers.js contract reads.

| Provider | URL | Use |
|----------|-----|-----|
| PublicNode | `https://ethereum-rpc.publicnode.com` | ETH mainnet |
| Base | `https://mainnet.base.org` | Base |
| LlamaRPC | `https://eth.llamarpc.com` | ETH mainnet |
| Blast | `https://rpc.blast.io` | Blast |

---

## API Usage Summary

| API | Monthly Cost | Calls/Day | Purpose |
|-----|--------------|-----------|---------|
| DeBank | $200/1M units | ~500 | Position scanning |
| Portals | Free (50K) | ~50 | Yield analytics |
| CoinGecko | Free | ~500 | Token prices |
| Aave | Free | ~100 | Reserve data |
| Morpho | Free | ~100 | Position data |
| Euler | Free (Goldsky) | ~50 | Vault data |
| Fluid | Free | ~50 | Vault data |
| Merkl | Free | ~100 | Incentive data |
| InfiniFi | Free | ~10 | RWA data |
| Pareto | Free | ~10 | Vault APY |
| Anzen | Free | ~10 | RWA data |
| 1inch | Free | ~10 | Token registry |
| DeFiLlama | Free | ~50 | Stablecoins + yields |
