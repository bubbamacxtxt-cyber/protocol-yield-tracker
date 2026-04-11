# Protocol Yield Tracker

Wallet position analyzer — tracks mezzanine DeFi protocols (vaults, yield-bearing stables) and their underlying yield sources.

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

## Current Whales (Mezzanine Protocols)

These are DeFi platforms with vaults or yield-bearing stables that return interest to depositors. We call them "whales" to distinguish from the underlying protocols they deposit into.

| Whale | Type | Vaults | Value |
|-------|------|--------|-------|
| Avant | Single | — | $100M |
| yoUSD | Single | — | $40M |
| Yuzu | Single | — | $63M |
| InfiniFi | Single (manual RWA) | — | $122M |
| Reservoir | Single | — | $350M |
| Makina | Multi-vault | Dialectic USD, Steakhouse USD | $21M |
| Upshift | Multi-vault | Core USDC, earnAUSD, singularV | — |
| Midas | Multi-vault | mHyper, mMev, mAPOLLO | — |
| Superform | Multi-vault | Flagship USDC SuperVault | — |


## Merkl Bonus Matching

Fetches Merkl incentive campaigns and applies bonus APYs to positions.

| Protocol | Matching Method | Status |
|----------|-----------------|--------|
| Morpho | By market ID (position_index) | ✅ |
| Aave | By market name (Horizon/Core/EtherFi/Lido) | ✅ |
| Euler | By vault address (Goldsky subgraph) | ✅ |
| Fluid | By vault address (Fluid REST API) | ✅ |

**Pipeline:** enrich-markets.js → fetch-merkl.js → export.js

## Roadmap

### Phase 1 — Yield Data ✅ (in progress)
- [x] On-chain position scanner (DeBank API)
- [x] Token registry (1inch + DeFiLlama + CoinGecko)
- [x] Manual RWA positions (InfiniFi CSV format)
- [x] Multi-vault support (Makina, Upshift, Midas, Superform)
- [ ] Yield-bearing stablecoin page (Portals APR data)
- [ ] Add yields to dashboard (APY display, multi-API math)

### Phase 2 — Automation
- [ ] GitHub Actions auto-update (daily scans + export)
- [ ] Cost tracking & monitoring (DeBank + Portals API budget)
- [ ] Client pricing model (daily delivery)

### Phase 3 — Whale Discovery
- [ ] Research & add more mezzanine protocols (DeFiLlama, on-chain)
- [ ] RWA yield tracking (APIs where available, manual CSV fallback)
- [ ] RWA protocol research (Centrifuge, Maple, Ondo, etc.)

### Phase 4 — Dashboard Polish
- [ ] Central yield view (all whales, all rates, sortable)
- [ ] Historical rate tracking (SQLite time series)
- [ ] Alerts / notifications on rate changes

## Setup

```bash
npm install
```

## Scan

```bash
# Scan one whale at a time (recommended)
DEBANK_API_KEY="<key>" node src/scan-whale.js <whale-name>

# Available whales: Avant, yoUSD, Yuzu, Reservoir, Makina, Upshift, Midas, Superform
# Multi-vault whales: scan-makina.js, scan-vault.js (see Add New Whale section)
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


## Protocol APIs

Detailed documentation for all protocol APIs used:

- **[API Reference](docs/API-REFERENCE.md)** — Complete guide for Aave, Morpho, Euler, Fluid APIs
- Query structures, parameters, examples, and notes for each protocol
- **[ALL-APIs.md](docs/ALL-APIs.md)** — Complete reference for all 14 APIs (DeBank, InfiniFi, Pareto, Anzen, Pendle, CoinGecko, 1inch, DeFiLlama, Portals, August Digital)
- Market enrichment system for Merkl bonus matching

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
