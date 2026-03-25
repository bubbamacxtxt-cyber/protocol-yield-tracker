# Protocol Yield Tracker

Wallet position analyzer — give it addresses, it finds what they're farming.

**GitHub:** bubbamacxtxt-cyber/protocol-yield-tracker
**Live:** https://bubbamacxtxt-cyber.github.io/protocol-yield-tracker/

---

## What It Does

1. Scan wallet addresses across all DeFi protocols via DeBank Cloud API
2. Find supply, borrow, and reward positions
3. Detect wallet-held tokens (not in protocols)
4. Classify strategies (loop, lend, farm, stake, lp, hold)
5. Store in SQLite database for historical tracking
6. Export to dashboard with XLSX download

## Data Source

**DeBank Cloud API** — covers 1000+ protocols across 50+ chains in a single API call.

| Endpoint | Use | Cost |
|----------|-----|------|
| `/v1/user/used_chain_list` | Which chains wallet is active on | 2 units |
| `/v1/user/chain_balance` | Total USD on a chain (pre-filter) | ~1 unit |
| `/v1/user/complex_protocol_list` | All protocol positions on a chain | 10 units |
| `/v1/user/token_list` | Wallet-held tokens (balance verification) | ~1 unit |

**Budget:** 1M units = $200. Current usage: ~$17 remaining.

## Token Registry

Cross-reference every token against multiple sources:
1. **1inch token list** — 2,570 tokens (address→symbol, 12 chains)
2. **DeFiLlama stablecoins** — 353 stablecoins (symbol-level)
3. **CoinGecko** — per-token fallback for unknowns, adds to registry

Registry grows over time — first scan uses CoinGecko, subsequent scans use cached registry.

## Balance Verification

After scanning positions, the scanner:
1. Gets `chain_balance` for each chain
2. Compares with total protocol positions
3. If gap > 5%, scans for wallet-held tokens
4. Adds wallet-held tokens as "Holding" positions

## Strategy Classification

| DeBank Type | Override | Strategy |
|------------|----------|----------|
| Lending (Aave, Morpho, Euler, Spark, etc.) | Always "Lending" | Loop (if borrow/HF) or Lend |
| Yield/Deposit (money markets) | → "Lending" | Loop (if borrow/HF) or Lend |
| Farming/Leveraged Farming | Keep | Farm |
| Staked/Locked | Keep | Stake |
| Liquidity Pool | Keep | LP |
| Wallet-held token | "Holding" | Hold |

## Current Whales

| Whale | Type | Positions | Value |
|-------|------|-----------|-------|
| Avant | Single | 13 | $100M |
| yoUSD | Single | 14 | $40M |
| Yuzu | Single | 25 | $63M |
| InfiniFi | Single (manual) | 9 | $122M |
| Reservoir | Single | 25 | $350M |
| Makina | Multi-vault | 16 | $21M |
| **Total** | | **101** | **$695M** |

## Setup

```bash
npm install
```

## Scan

```bash
# Scan one whale at a time (recommended)
DEBANK_API_KEY="<key>" node src/scan-whale.js <whale-name>

# Available whales: Avant, yoUSD, Yuzu, Reservoir, Makina
```

## Export

```bash
node src/export.js
```
Generates `data.json` for dashboard.

## Build Token Registry

```bash
node src/build-token-list.js
```
Downloads token lists from 1inch + DeFiLlama. Run once, refresh weekly.

## Add New Whale

1. Add wallet addresses to `data/whales.json`
2. Scan: `DEBANK_API_KEY="<key>" node src/scan-whale.js <name>`
3. Export: `node src/export.js`
4. Create page from `template.html` (replace WHALE_NAME, WHALE_KEY, WHALE_SLUG)
5. For multi-vault: create `makina.html` overview + `makina/{vault}.html` detail pages

## Add Manual Positions (RWAs)

Edit `data/manual-positions.json`:
```json
{
  "WhaleName": [
    {
      "wallet": "0x...",
      "chain": "eth",
      "protocol_name": "Protocol Name",
      "position_type": "Illiquid",
      "strategy": "rwa",
      "net_usd": 1000000,
      "supply": [{"symbol": "USDC", "amount": 1000000, "price_usd": 1, "value_usd": 1000000}],
      "borrow": [],
      "apy_current": 5.5,
      "maturity": "2026-06-30",
      "manual": true
    }
  ]
}
```

## File Structure

```
protocol-yield-tracker/
├── README.md
├── template.html              # Whale page template
├── index.html                 # Home page (whale list)
├── avant.html                 # Single-vault detail page
├── makina.html                # Multi-vault overview page
├── makina/
│   ├── dialectic-usd.html     # Vault detail page
│   └── steakhouse-usd.html    # Vault detail page
├── data/
│   ├── whales.json            # Whale wallet definitions
│   ├── wallets.json           # All wallet addresses
│   ├── manual-positions.json  # RWA positions
│   ├── debank-scan.json       # Latest scan results
│   └── token-registry.json    # Token registry
├── src/
│   ├── scan-whale.js          # Scan one whale (MAIN SCANNER)
│   ├── scan-makina.js         # Makina-specific scanner
│   ├── fetch.js               # Full scanner (all wallets)
│   ├── export.js              # Export to data.json
│   └── build-token-list.js    # Token registry builder
├── docs/
│   └── TEMPLATE.md            # How to add new whales
└── yield-tracker.db           # SQLite database
```

## API Rate Limits

| API | Limit | Our Usage |
|-----|-------|-----------|
| DeBank Cloud | 100 req/sec | ~50 calls per whale |
| CoinGecko | ~20/min | Only for unknown tokens |

## Dashboard Features

- Home page with whale list (net value, wallet count, position count)
- Whale detail pages with filters (protocol, chain, strategy, min $)
- Multi-vault support (click whale → vault list → vault detail)
- Health factor color coding (🔴 <1.05, 🟡 <1.15, 🟢 >1.15)
- Strategy badges (loop, lend, farm, stake, lp, hold)
- DeBank profile links on wallet addresses
- XLSX download for Google Sheets

## Related Projects

- [Aave Yield Dashboard](https://github.com/bubbamacxtxt-cyber/aave-yield-dashboard) — Direct Aave/Fluid yield tracking
- [Yield Portal](https://github.com/bubbamacxtxt-cyber/yield-portal) — Multi-protocol yield analytics

## Team

- **Saus** — CEO, project lead
- **Bub2** — Builder
- **Chief** — CTO, infrastructure
