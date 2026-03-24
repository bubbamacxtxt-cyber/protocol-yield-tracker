# Protocol Yield Tracker

Wallet position analyzer — give it addresses, it finds what they're farming.

**GitHub:** bubbamacxtxt-cyber/protocol-yield-tracker

---

## What It Does

1. Scan wallet addresses across all DeFi protocols
2. Find their supply, borrow, and reward positions
3. Classify strategies (loop, lend, borrow, vault)
4. Store in SQLite database for historical tracking

## Data Source

**DeBank Cloud API** — covers 1000+ protocols across 50+ chains in a single API call.

| Endpoint | Use | Cost |
|----------|-----|------|
| `/v1/user/used_chain_list` | Which chains wallet is active on | 2 units |
| `/v1/user/complex_protocol_list` | All protocol positions on a chain | 10 units |

**Budget:** 1M units = $200. Full scan of 20 wallets = ~3,000 units = $0.60.

## Current Scan Results

- **20 wallets scanned**, 4 with positions >$50K
- **13 positions** across 6 chains
- **3 protocols**: Aave V3, Morpho, Ethena
- **$102.1M total** net value

### By Protocol
| Protocol | Positions | Total |
|----------|-----------|-------|
| Aave V3 | 8 | $89.2M |
| Ethena | 1 | $8.1M |
| Morpho | 4 | $4.8M |

### By Chain
| Chain | Positions | Total |
|-------|-----------|-------|
| Ethereum | 6 | $45.5M |
| Plasma | 2 | $26.0M |
| Mantle | 1 | $18.7M |
| Ink | 1 | $5.6M |
| Base | 1 | $4.8M |
| Arbitrum | 2 | $1.5M |

### By Wallet
| Wallet | Positions | Total | Protocols |
|--------|-----------|-------|-----------|
| 0xc468...4CA6 | 3 | $47.0M | Aave V3, Ethena |
| 0x920E...64d7 | 3 | $29.0M | Aave V3 |
| 0x3207...7910 | 2 | $16.4M | Aave V3 |
| 0x7bee...0FAb | 5 | $9.7M | Aave V3, Morpho |

## Setup

```bash
npm install
```

## Fetch

```bash
node src/fetch.js
```

## Database

SQLite (`yield-tracker.db`) with:
- **wallets** — wallet addresses and labels
- **positions** — protocol positions (supply, borrow, rewards, USD values)
- **snapshots** — historical tracking for position changes

## File Structure

```
protocol-yield-tracker/
├── README.md
├── package.json
├── data/
│   ├── wallets.json          # Wallet addresses to scan
│   └── debank-scan.json      # Latest scan results
└── src/
    └── fetch.js              # Main fetcher (Aave + Morpho GraphQL)
```

## How It Works

1. **Chain discovery** — DeBank tells us which chains each wallet is active on
2. **Position scan** — Get all protocol positions per chain (supply, borrow, rewards)
3. **Filter** — Only keep positions >$50K net value
4. **Store** — Save to SQLite for historical tracking
5. **Export** — Generate JSON for dashboard

## API Rate Limits

| API | Limit | Our Usage |
|-----|-------|-----------|
| DeBank Cloud | 100 req/sec | ~200 calls per scan |
| Aave v3 GraphQL | None | Direct queries when needed |
| Morpho GraphQL | None | Direct queries when needed |

## Related Projects

- [Aave Yield Dashboard](https://github.com/bubbamacxtxt-cyber/aave-yield-dashboard) — Direct Aave/Fluid yield tracking
- [Yield Portal](https://github.com/bubbamacxtxt-cyber/yield-portal) — Multi-protocol yield analytics

## Team

- **Saus** — CEO, project lead
- **Bub2** — Builder
- **Chief** — CTO, infrastructure
