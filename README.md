# Protocol Yield Tracker

Multi-protocol DeFi position analyzer. Given a list of EVM wallet addresses, discovers and classifies their lending, borrowing, and looping strategies across Aave v3, Morpho, and other protocols.

**GitHub:** bubbamacxtxt-cyber/protocol-yield-tracker
**Live:** https://bubbamacxtxt-cyber.github.io/protocol-yield-tracker/

---

## What It Does

1. Takes a list of EVM wallet addresses
2. Queries each protocol's API for positions
3. Identifies supply (collateral) and borrow (debt) positions
4. Classifies strategies (looping, lending, yield farming)
5. Stores results in SQLite database
6. Exports to JSON for dashboard display

---

## Data Sources

### Aave v3 — GraphQL API

**Endpoint:** `https://api.v3.aave.com/graphql`
**Auth:** None required
**Coverage:** 20+ chains (Ethereum, Base, Arbitrum, Avalanche, Optimism, Polygon, BSC, Sonic, Plasma, Mantle, Scroll, Celo, Gnosis, Linea, Metis, zkSync, Ink, MegaETH, Soneium)

#### Key Queries

```graphql
# List all supported chains
query Chains {
  chains { name chainId }
}

# Get market (Pool) address for a chain
query Markets {
  markets(request: { chainIds: [9745] }) {
    address
    name
    chain { name chainId }
    reserves { underlyingToken { symbol address decimals } }
  }
}

# Get user's aggregate position (collateral, debt, health)
query UserState {
  userMarketState(request: {
    user: "0xWALLET"
    chainId: 9745
    market: "0xPOOL_ADDRESS"
  }) {
    totalCollateralBase
    totalDebtBase
    healthFactor
  }
}

# Get user's supplied tokens (collateral)
query UserSupplies {
  userSupplies(request: {
    user: "0xWALLET"
    markets: [{ address: "0xPOOL", chainId: 9745 }]
    collateralsOnly: false
    orderBy: { balance: DESC }
  }) {
    currency { symbol address decimals }
    balance { amount { value } usd }
    apy { formatted }
    isCollateral
  }
}

# Get user's borrowed tokens (debt)
query UserBorrows {
  userBorrows(request: {
    user: "0xWALLET"
    markets: [{ address: "0xPOOL", chainId: 9745 }]
    orderBy: { debt: DESC }
  }) {
    currency { symbol address decimals }
    debt { amount { value } usd }
    apy { formatted }
  }
}
```

#### Known Market (Pool) Addresses

| Chain | Chain ID | Pool Address | Market Name |
|-------|----------|-------------|-------------|
| Ethereum | 1 | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` | AaveV3Ethereum |
| Base | 8453 | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | AaveV3Base |
| Arbitrum | 42161 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | AaveV3Arbitrum |
| Avalanche | 43114 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | AaveV3Avalanche |
| Optimism | 10 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | AaveV3Optimism |
| Polygon | 137 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | AaveV3Polygon |
| BSC | 56 | `0x6807dc923806fE8Fd134338EABCA509979a7e0cB` | AaveV3Bsc |
| Sonic | 146 | `0x5362dBb1e601AbF2a150D1999Be54a4d308f4F6e` | AaveV3Sonic |
| **Plasma** | **9745** | **`0x925a2A7214Ed92428B5b1B090F80b25700095e12`** | **AaveV3Plasma** |
| **Mantle** | **5000** | **`0x458F293454fE0d67EC0655f3672301301DD51422`** | **AaveV3Mantle** |

> ⚠️ Don't hardcode pool addresses. Query `markets(request: { chainIds: [...] })` to get them dynamically.

#### Schema Notes

- `balance` and `debt` return `TokenAmount` with `amount { value }` and `usd` (both `BigDecimal` scalars)
- `apy` returns `PercentValue` with `formatted` (string like "3.30") and `value` (raw number)
- `orderBy` is an input object, e.g. `{ balance: DESC }` or `{ debt: DESC }`
- `collateralsOnly: false` is required to see all supplies including non-collateral tokens

---

### Morpho — GraphQL API

**Endpoint:** `https://api.morpho.org/graphql`
**Auth:** None required
**Coverage:** Ethereum, Base, Arbitrum, Optimism, Polygon

#### Key Queries

```graphql
# Get user's market positions (supply + borrow)
query UserPositions($address: String!, $chainId: Int!) {
  userByAddress(address: $address, chainId: $chainId) {
    marketPositions {
      market {
        uniqueKey
        loanAsset { address symbol }
        collateralAsset { address symbol }
        state {
          borrowApy
          supplyApy
          utilization
        }
      }
      supplyAssets
      borrowAssets
      supplyAssetsUsd
      borrowAssetsUsd
    }
    vaultPositions {
      vault { address name asset { address symbol } }
      assets
      assetsUsd
    }
  }
}
```

#### Schema Notes

- APY values are returned as decimals (e.g., 0.0399 = 3.99%), multiply by 100 for percentage
- `supplyAssetsUsd` and `borrowAssetsUsd` return the USD value of positions
- Supports all major EVM chains via `chainId` parameter

---

### Portals API — Token Balances

**Endpoint:** `https://api.portals.fi/v2/account`
**Auth:** `Authorization: Bearer API_KEY` (50K calls/month free tier)
**Coverage:** Ethereum, Arbitrum, Base, Optimism, Avalanche, Polygon, BSC, Sonic, HyperEVM

Useful for getting basic token balances across all chains, but does NOT expose DeFi positions (lending supply/borrow).

```bash
curl "https://api.portals.fi/v2/account?owner=0xWALLET&networks[]=ethereum&networks[]=base&networks[]=arbitrum" \
  -H "Authorization: Bearer API_KEY"
```

---

## Strategy Classification

### Looping Detection

A position is classified as a **loop** when:
- User supplies token A as collateral
- User borrows token B against it
- Utilization is >80% (leveraged position)
- Health factor is 1.01-1.10 (tight margin)

### Common Strategies Found

| Strategy | Collateral | Borrow | Source |
|----------|-----------|--------|--------|
| Ethena Loop | USDe / sUSDe | USDC / USDT / USDT0 | Ethena (funding rate yield) |
| Maple Loop | syrupUSDC / syrupUSDT | USDC / USDT / USDT0 / PYUSD | Maple Finance (RWA lending) |
| Pendle Loop | PT-sUSDe | USDe | Pendle (fixed yield) |
| Basic Lending | ETH / stETH | USDC | Simple collateralized loan |

### Yield Sources

- **Ethena USDe:** Delta-neutral ETH position, earns funding rate from perpetual futures
- **sUSDe:** Staked USDe, auto-compounding version
- **syrupUSDC/syrupUSDT:** Maple Finance RWA lending tokens, backed by institutional loans
- **syrupUSDC (Morpho):** Maple vault positions on Morpho, higher APY than Aave

---

## Architecture

```
protocol-yield-tracker/
├── src/
│   ├── protocols/
│   │   ├── aave-v3.js          # Aave v3 GraphQL queries
│   │   ├── morpho.js           # Morpho GraphQL queries
│   │   └── compound.js         # Compound (future)
│   ├── classify.js              # Strategy classification
│   ├── fetch.js                 # Main fetcher
│   └── export.js                # JSON export for dashboard
├── data/
│   └── markets.json             # Known pool addresses per chain
├── index.html                   # Dashboard
├── schema.sql                   # SQLite schema
├── package.json
├── .github/workflows/
│   └── update-data.yml          # Auto-refresh
└── README.md
```

### SQLite Schema

```sql
CREATE TABLE wallets (
  id INTEGER PRIMARY KEY,
  address TEXT UNIQUE NOT NULL,
  label TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  wallet_id INTEGER REFERENCES wallets(id),
  protocol TEXT NOT NULL,           -- 'aave-v3', 'morpho', 'compound'
  chain TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  market_address TEXT NOT NULL,
  collateral_token TEXT,
  collateral_usd REAL,
  collateral_apy REAL,
  borrow_token TEXT,
  borrow_usd REAL,
  borrow_apy REAL,
  health_factor REAL,
  utilization REAL,
  strategy TEXT,                     -- 'loop', 'lend', 'vault', 'unknown'
  yield_source TEXT,                 -- 'ethena', 'maple', 'pendle', etc.
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  position_id INTEGER REFERENCES positions(id),
  timestamp TEXT DEFAULT (datetime('now')),
  collateral_usd REAL,
  borrow_usd REAL,
  health_factor REAL
);
```

---

## Setup

```bash
npm install
PORTALS_API_KEY=xxx node fetch.js
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORTALS_API_KEY` | No | For Portals token balances (optional) |

No API keys needed for Aave v3 or Morpho GraphQL APIs.

---

## Rate Limits

| API | Limit | Our Usage |
|-----|-------|-----------|
| Aave v3 GraphQL | None (free) | ~20 queries/wallet |
| Morpho GraphQL | None (free) | ~5 queries/wallet |
| Portals | 50K calls/month | 1 query/wallet |

---

## Future

- [ ] Compound v3 positions
- [ ] Pendle positions
- [ ] Spark/MakerDAO positions
- [ ] Euler positions
- [ ] Historical snapshots (track position changes over time)
- [ ] Alert system (health factor drops, new positions opened)
- [ ] Portfolio PnL tracking
- [ ] Risk scoring per position
