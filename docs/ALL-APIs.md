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
**Cost:** Free

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

### Full Example (from fetch-merkl.js)

```javascript
const https = require('https');

const CHAINS = {
  eth: 1, arb: 42161, base: 8453, plasma: 9745,
  mnt: 5000, sonic: 146, bsc: 56, monad: 143,
};

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

async function fetchMerklOpportunities(chainIds = [1, 42161, 8453]) {
  const ids = chainIds.join(',');
  const url = `https://api.merkl.xyz/v4/opportunities?chainIds=${ids}&status=LIVE&limit=1000`;
  const data = await postJSON(url, { query: '{ items { id name type action identifier apr tokens rewardTokens tags } }' });
  return data.items || [];
}

// ─── Match campaigns to positions ────────────────────────────────
function matchCampaignToPosition(campaign, position) {
  // Check protocol tags
  const protocol = campaign.tags?.[0];
  if (protocol !== position.protocol_name?.toLowerCase()) return false;
  
  // Check if position's tokens are in campaign's required tokens
  const campaignTokens = campaign.tokens?.map(t => t.symbol?.toLowerCase());
  const positionTokens = position.tokens?.map(t => t.symbol?.toLowerCase());
  
  return campaignTokens?.some(ct => positionTokens?.includes(ct));
}

// ─── Protocol mapping for Merkl tags ─────────────────────────────
const PROTOCOL_MAP = {
  'Aave V3': ['aave', 'aave-v3'],
  'Morpho': ['morpho', 'morpho-blue'],
  'Euler': ['euler', 'euler-v2'],
  'Fluid': ['fluid'],
};

function matchesProtocol(campaign, protocolName) {
  const merklTags = PROTOCOL_MAP[protocolName] || [];
  return campaign.tags?.some(t => merklTags.includes(t));
}
```

---

## InfiniFi API

**Base URL:** 
- ETH: `https://eth-api.infinifi.xyz/api/protocol/data`
- Plasma: `https://plasma-api.infinifi.xyz/api/protocol/data`

**Auth:** None  
**Cost:** Free

### How It Works

InfiniFi returns position data for their RWA vault. We map vault deposit names to underlying protocols (which we detect automatically via DeBank).

### Full Example (from fetch-infinifi.js)

```javascript
const https = require('https');

const INFINIFI_ENDPOINTS = [
  { chain: 'eth', url: 'https://eth-api.infinifi.xyz/api/protocol/data' },
  { chain: 'plasma', url: 'https://plasma-api.infinifi.xyz/api/protocol/data' },
];

function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

async function fetchInfiniFi() {
  const positions = [];
  
  for (const { chain, url } of INFINIFI_ENDPOINTS) {
    const data = await fetchJSON(url);
    
    // Each vault has yield sources with APY
    for (const vault of data.vaults || []) {
      const totalValue = parseFloat(vault.total_value || 0);
      if (totalValue < 1000) continue; // Skip dust
      
      positions.push({
        chain,
        wallet: vault.depositor_address,
        net_usd: totalValue,
        apy_current: parseFloat(vault.apy || 0) * 100,
        supply: [{
          symbol: vault.token_symbol,
          amount: parseFloat(vault.token_amount || 0),
          value_usd: totalValue,
        }],
        yield_source: vault.strategy_name,
      });
    }
  }
  
  return positions;
}
```

### Yield Source Mapping

We map vault strategy names to underlying protocols for DeBank detection:

```javascript
const YIELD_SOURCE_MAP = {
  'morpho-steakUSDCinfinifi': 'morpho',
  'morpho-steakUSDTinfinifi': 'morpho',
  'tokemak-auto-infinifiUSD': 'tokemak',
  'moonwell-infinifiUSDC': 'moonwell',
};

function getUnderlyingProtocol(strategyName) {
  // Check direct map first
  if (YIELD_SOURCE_MAP[strategyName]) return YIELD_SOURCE_MAP[strategyName];
  
  // Auto-detect: extract protocol from name like 'morpho-steakUSDCinfinifi'
  const match = strategyName.match(/^([a-z]+)/);
  return match ? match[1] : 'unknown';
}
```

---

## Pareto API

**Base URL:** `https://app.pareto.credit/api/v1`  
**Auth:** None  
**Cost:** Free  
**On-chain Contract:** `ParetoDollarQueue` at `0xA7780086ab732C110E9E71950B9Fb3cb2ea50D89`

### How It Works

Pareto has two data sources:
1. **REST API** — Vault block history with APY data
2. **On-chain** — Live APY and total deposits via contract reads

### Full Example (from fetch-pareto.js)

```javascript
const { ethers } = require('ethers');
const https = require('https');

const PARETO_QUEUE = '0xA7780086ab732C110E9E71950B9Fb3cb2ea50D89';
const API_BASE = 'https://app.pareto.credit/api/v1';

// ─── REST API: Get vault APY history ─────────────────────────────
function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

async function getParetoApiData() {
  // Get latest vault block
  const data = await fetchJSON(`${API_BASE}/vault-blocks?limit=1`);
  const block = data[0];
  
  return {
    apy: parseFloat(block.apy || 0),  // Already as percentage
    tvl: parseFloat(block.tvl || 0),
    timestamp: block.timestamp,
  };
}

// ─── On-chain: Get live APY + deposits ────────────────────────────
async function getParetoOnChain() {
  const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
  
  const queue = new ethers.Contract(PARETO_QUEUE, [
    'function getAPY() view returns (uint256)',
    'function getTotalDeposits() view returns (uint256)',
    'function getPricePerShare() view returns (uint256)',
  ], provider);
  
  const [apyRaw, depositsRaw, ppsRaw] = await Promise.all([
    queue.getAPY(),
    queue.getTotalDeposits(),
    queue.getPricePerShare(),
  ]);
  
  // APY is in basis points (10000 = 100%)
  const apy = Number(apyRaw) / 100;
  
  // Deposits has 6 decimals (USDC)
  const deposits = Number(depositsRaw) / 1e6;
  
  return { apy, deposits };
}

// ─── Combine both sources ─────────────────────────────────────────
async function fetchParetoPositions() {
  const [apiData, chainData] = await Promise.all([
    getParetoApiData(),
    getParetoOnChain(),
  ]);
  
  return {
    net_usd: chainData.deposits,
    apy_current: chainData.apy || apiData.apy,  // Prefer on-chain
    source: 'Pareto sUSP',
  };
}
```

---

## Anzen API

**Base URL:** `https://rwa-api.anzen.finance/collaterals`  
**Auth:** None  
**Cost:** Free  
**On-chain:** USDz token varies by chain (e.g., ETH mainnet)

### How It Works

Anzen API returns collateral data for USDz. We combine this with on-chain USDz supply to get total value locked.

### Full Example (from fetch-anzen.js)

```javascript
const { ethers } = require('ethers');
const https = require('https');

const API_URL = 'https://rwa-api.anzen.finance/collaterals?page=1';

function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

// ─── REST API: Get collateral data ───────────────────────────────
async function fetchAnzenCollaterals() {
  const data = await fetchJSON(API_URL);
  
  // data.collaterals is array of collateral types
  return data.collaterals.map(c => ({
    name: c.name,
    symbol: c.symbol,
    tvl: parseFloat(c.tvl || 0),
    apy: parseFloat(c.apy || 0),
    risk_level: c.risk_level,
  }));
}

// ─── On-chain: Get USDz total supply ─────────────────────────────
async function getUSDzSupply() {
  const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
  
  // USDz token contract on ETH mainnet
  const USDZ = '0x...'; // Find actual address from Etherscan
  
  const token = new ethers.Contract(USDZ, [
    'function totalSupply() view returns (uint256)',
    'function decimals() view returns (uint8)',
  ], provider);
  
  const [supply, decimals] = await Promise.all([
    token.totalSupply(),
    token.decimals(),
  ]);
  
  return Number(supply) / Math.pow(10, decimals);
}

// ─── Combine for whale position ──────────────────────────────────
async function fetchAnzenPosition() {
  const [collaterals, totalSupply] = await Promise.all([
    fetchAnzenCollaterals(),
    getUSDzSupply(),
  ]);
  
  // Calculate weighted average APY
  const totalTvl = collaterals.reduce((s, c) => s + c.tvl, 0);
  const weightedApy = collaterals.reduce((s, c) => s + c.apy * (c.tvl / totalTvl), 0);
  
  return {
    net_usd: totalSupply,  // From on-chain
    apy_current: weightedApy * 100,  // Convert to percentage
    collaterals,
    source: 'Anzen USDz',
  };
}
```

---

## Pendle API

**Base URL:** `https://api-v2.pendle.finance/core/v1/`  
**Auth:** None  
**Cost:** Free  
**Note:** Rate limited — use delays between calls

### Endpoints

| Endpoint | Use |
|----------|-----|
| `/markets?chain_id={id}` | All markets |
| `/tokens?chain_id={id}` | Token info |
| `/markets/{address}?chain_id={id}` | Single market details |

### Full Example

```javascript
const https = require('https');

function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

async function fetchPendleMarkets(chainId = 1) {
  const data = await fetchJSON(
    `https://api-v2.pendle.finance/core/v1/markets?chain_id=${chainId}`
  );
  
  return data.markets?.map(m => ({
    address: m.address,
    name: m.name,
    pt_symbol: m.pt?.symbol,  // Principal Token
    yt_symbol: m.yt?.symbol,  // Yield Token
    underlying_asset: m.underlyingAsset?.symbol,
    maturity: m.maturity,
    implied_apy: parseFloat(m.impliedYield || 0) * 100,
  })) || [];
}

// ─── Get market for specific token ───────────────────────────────
async function findPendleMarket(tokenSymbol, chainId = 1) {
  const markets = await fetchPendleMarkets(chainId);
  return markets.find(m => 
    m.pt_symbol?.includes(tokenSymbol) || 
    m.yt_symbol?.includes(tokenSymbol) ||
    m.underlying_asset?.includes(tokenSymbol)
  );
}
```

---

## CoinGecko API

**Base URL:** `https://api.coingecko.com/api/v3`  
**Auth:** None (free tier)  
**Rate Limit:** ~20 requests/min (free)

### How We Use It

CoinGecko is our fallback for unknown tokens. When DeBank doesn't return a token symbol, we look it up by contract address.

### Full Example

```javascript
const https = require('https');

const CHAIN_MAP = {
  eth: 'ethereum', arb: 'arbitrum-one', base: 'base',
  poly: 'polygon-pos', bsc: 'binance-smart-chain',
  avax: 'avalanche', op: 'optimistic-ethereum',
};

function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { res(JSON.parse(d)); } 
        catch(e) { rej(new Error(`Parse error: ${d.slice(0,100)}`)); }
      });
    }).on('error', rej);
  });
}

// ─── Get token price by contract address ─────────────────────────
async function getTokenPrice(chain, contractAddress) {
  const platform = CHAIN_MAP[chain] || 'ethereum';
  
  try {
    const data = await fetchJSON(
      `https://api.coingecko.com/api/v3/simple/token_addresses/${platform}?` +
      `contract_addresses=${contractAddress}&vs_currencies=usd`
    );
    
    const key = contractAddress.toLowerCase();
    return data[key]?.usd || 0;
  } catch(e) {
    // Rate limited or error — return 0
    return 0;
  }
}

// ─── Batch price lookup ──────────────────────────────────────────
async function batchGetPrices(contractAddresses) {
  const addrStr = contractAddresses.join(',');
  const data = await fetchJSON(
    `https://api.coingecko.com/api/v3/simple/token_addresses/ethereum?` +
    `contract_addresses=${addrStr}&vs_currencies=usd`
  );
  
  const prices = {};
  for (const [addr, info] of Object.entries(data)) {
    prices[addr.toLowerCase()] = info.usd || 0;
  }
  return prices;
}

// ─── Use in scanner (with delay for rate limit) ──────────────────
async function resolveUnknownToken(contractAddress, chain = 'eth') {
  await sleep(12000);  // Wait 12s between calls
  
  const price = await getTokenPrice(chain, contractAddress);
  
  return {
    address: contractAddress.toLowerCase(),
    price_usd: price,
    source: 'coingecko',
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
```

---

## 1inch Token List

**Base URL:** `https://tokens.1inch.io`  
**Auth:** None  
**Cost:** Free

### How We Use It

1inch provides a comprehensive token list that we use as our primary token registry. Every token address gets mapped to a human-readable symbol.

### Endpoints

| Endpoint | Chain | Token Count |
|----------|-------|-------------|
| `/v6.0/1` | Ethereum | ~2,570 |
| `/v6.0/42161` | Arbitrum | ~800 |
| `/v6.0/8453` | Base | ~500 |
| `/v6.0/137` | Polygon | ~400 |
| `/v6.0/56` | BSC | ~600 |

### Full Example (from build-token-list.js)

```javascript
const https = require('https');

const CHAINS = [1, 42161, 8453, 137, 56, 10, 43114, 250, 100];

function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

// ─── Build token registry from 1inch ─────────────────────────────
async function buildTokenRegistry() {
  const registry = {};  // { address: { symbol, decimals, chain } }
  
  for (const chainId of CHAINS) {
    console.log(`Fetching chain ${chainId}...`);
    
    try {
      const tokens = await fetchJSON(
        `https://tokens.1inch.io/v6.0/${chainId}`
      );
      
      for (const token of tokens) {
        const addr = token.address?.toLowerCase();
        if (!addr) continue;
        
        registry[addr] = {
          symbol: token.symbol?.toUpperCase(),
          decimals: token.decimals,
          name: token.name,
          chainId,
        };
      }
      
      console.log(`  Got ${tokens.length} tokens`);
      await sleep(1000);  // Rate limit
    } catch(e) {
      console.log(`  Error on chain ${chainId}: ${e.message}`);
    }
  }
  
  return registry;
}

// ─── Lookup token symbol ─────────────────────────────────────────
function getSymbol(registry, address, chainId = 1) {
  const key = address.toLowerCase();
  const token = registry[key];
  
  if (token && token.chainId === chainId) {
    return token.symbol;
  }
  
  // Try any chain
  return token?.symbol || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
```

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
| `/stablecoins/{id}` | Single stablecoin details |
| `/protocols` | Protocol info |
| `/chart/{pool}` | Historical APY for a pool |

### Full Example

```javascript
const https = require('https');

function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

// ─── Get all stablecoins ─────────────────────────────────────────
async function getStablecoins() {
  const data = await fetchJSON('https://stablecoins.llama.fi/stablecoins');
  
  return data.peggedAssets?.map(s => ({
    name: s.name,
    symbol: s.symbol,
    id: s.id,
    chains: Object.keys(s.chainCirculating || {}),
    totalCirculating: {
      usd: Object.values(s.chainCirculating || {})
        .reduce((sum, c) => sum + (c.current?.peggedUSD || 0), 0),
    },
  })) || [];
}

// ─── Build stablecoin symbol registry ────────────────────────────
async function buildStablecoinRegistry() {
  const stablecoins = await getStablecoins();
  const registry = new Set();
  
  for (const s of stablecoins) {
    // Add common symbols
    registry.add(s.symbol?.toUpperCase());
    
    // Add variations (e.g., 'USDC.e' -> 'USDC')
    if (s.symbol?.includes('.')) {
      registry.add(s.symbol.split('.')[0].toUpperCase());
    }
  }
  
  return registry;  // Use: registry.has('USDC') to check
}

// ─── Get yield pools for a protocol ──────────────────────────────
async function getProtocolPools(protocolName) {
  const data = await fetchJSON('https://yields.llama.fi/pools');
  
  return data.data?.filter(p => 
    p.project?.toLowerCase() === protocolName.toLowerCase()
  ).map(p => ({
    pool: p.pool,
    chain: p.chain,
    symbol: p.symbol,
    apy: p.apy,
    tvlUsd: p.tvlUsd,
  })) || [];
}
```

---

## Portals API

**Base URL:** `https://api.portals.fi/v2`  
**Auth:** Bearer token  
**Budget:** 50,000 calls/month (~50/day)

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

### Full Example (from Yield Portal)

```javascript
const https = require('https');

const PORTALS_KEY = 'e9302cf2-58c8-4275-a533-ed0342b78fff';
const CHAIN_IDS = { eth: 1, arb: 42161, base: 8453, poly: 137, bsc: 56 };

function fetchJSON(url, headers = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'Authorization': `Bearer ${PORTALS_KEY}`, ...headers }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    });
    req.on('error', rej);
    req.end();
  });
}

// ─── Fetch tokens with yield (stablecoins, lending, etc.) ────────
async function fetchPortalsTokens(chainId = 1, minTvl = 1000000) {
  const data = await fetchJSON(
    `https://api.portals.fi/v2/tokens?chains=${chainId}&minTvl=${minTvl}`
  );
  
  return data.tokens?.map(t => ({
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    price_usd: t.price,
    apy: parseFloat(t.apy || 0),
    tvl: parseFloat(t.tvl || 0),
    protocol: t.platform?.name,
    category: t.category,
  })) || [];
}

// ─── Fetch wallet positions ──────────────────────────────────────
async function fetchWalletPositions(walletAddress) {
  const data = await fetchJSON(
    `https://api.portals.fi/v2/account?owner=${walletAddress}`
  );
  
  return data.positions?.map(p => ({
    protocol: p.platform?.name,
    symbol: p.token?.symbol,
    balance_usd: p.value,
    apy: parseFloat(p.apy || 0),
  })) || [];
}

// ─── Two-tier fetch: large TVL first, then lending platforms ────
async function fetchYieldPortalData() {
  // Tier 1: All tokens with >$1M TVL
  const largeTokens = await fetchPortalsTokens(1, 1000000);
  
  // Tier 2: Lending platforms specifically
  const LENDING_PLATFORMS = [
    'compound-v3', 'morpho', 'fluid', 'euler', 'aavev3', 'spark'
  ];
  
  const lendingTokens = [];
  for (const platform of LENDING_PLATFORMS) {
    const tokens = await fetchJSON(
      `https://api.portals.fi/v2/tokens?platforms=${platform}&minTvl=100000`
    );
    lendingTokens.push(...(tokens.tokens || []));
  }
  
  return { largeTokens, lendingTokens };
}
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
