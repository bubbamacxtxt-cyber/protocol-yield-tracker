# Position Discovery Architecture v2

_Saved 2026-04-15. Build target: 2026-04-16_

## The Shift

**Old model:** Protocol → market → check if wallet holds (doesn't scale, misses positions)

**New model:** Wallet → all tokens held → identify what each token is (catches everything)

---

## Pipeline: 4 Layers

```
Layer 1: DISCOVERY        Layer 2: IDENTIFICATION     Layer 3: ENRICHMENT       Layer 4: STORAGE
━━━━━━━━━━━━━━━━━━━━      ━━━━━━━━━━━━━━━━━━━━━━━━    ━━━━━━━━━━━━━━━━━━━━━━    ━━━━━━━━━━━━━
alchemy_getTokenBalances   Probe for ERC-4626          Protocol APIs             SQLite DB
  → all tokens held          asset() on each token       → APY, TVL, risk         → positions
                                                                                   → history
                           Cross-reference against      Merkl rewards API
                           vault registry                → bonus APY
                             
                           Cross-reference against      
                           known protocol tokens        DeBank (optional)
                           (aTokens, stTokens, etc)       → NFT, LP positions
```

---

## Layer 1: Discovery (replaces DeBank balance scan)

**One call per wallet per chain:**
- `alchemy_getTokenBalances(wallet, 'erc20')` → all tokens with balances
- CU cost: ~75 CU/call
- Covers: Ethereum, Base, Arbitrum, Polygon, Optimism, BSC, Sonic, Mantle, etc.

**For 150 wallets × 5 chains:**
- 750 calls × 75 CU = 56,250 CU/month
- Free tier: 30,000,000 CU → **0.19% of budget**

---

## Layer 2: Identification (what is each token?)

### Step A: Metadata
- `alchemy_getTokenMetadata` → symbol, decimals, name
- Already in the same Alchemy key, ~20 CU/call

### Step B: Is it a vault?
- `eth_call` to `asset()` selector (`0x52ef1b7d`) on each unknown token
- If returns an address → it's an ERC-4626 vault, underlying asset = returned address
- If reverts → not a vault, treat as plain token

### Step C: Match against known registries
- Aave aTokens (aEthUSDC, aEthPYUSD, etc.) → map to Aave v3 market
- Morpho vaults (senPYUSDv2, steakPYUSD, etc.) → map to Morpho v2/internal API
- Euler vaults (ePYUSD-6, eRLUSD-7, etc.) → map to Euler indexer
- Lido, Rocket Pool, etc. → staking protocols
- Gauge tokens (PYUSDUSDC-gauge) → Curve/Convex

### Vault Registry File
```
data/protocol-tokens.json
{
  "morpho-vaults": { address → { symbol, asset, protocol, chain } },
  "euler-vaults": { address → { symbol, asset, protocol, chain } },
  "aave-atokens": { address → { symbol, underlying, marketId, chain } },
  "curve-gauges": { address → { symbol, pool, chain } },
  ...
}
```

---

## Layer 3: Enrichment (APY, rewards, context)

| Protocol | API | CU Cost | Data |
|----------|-----|---------|------|
| Morpho | `app.morpho.org/api/graphql` (internal) | 0 | APY, TVL, exposure, Merkl |
| Euler | Indexer (`indexer.euler.xyz`) | 0 | APY, TVL, rewards |
| Aave | Public GraphQL | 0 | Supply/borrow APY |
| Merkl | `api.merkl.xyz/v4/opportunities` | 0 | Bonus rewards |
| DeFiLlama | `yields.llama.fi` | 0 | Fallback APY data |

**Zero CU cost for enrichment.** All off-chain APIs.

---

## Layer 4: Storage & History

SQLite tables:
```sql
positions (wallet, chain, protocol, vault_address, symbol, asset, shares, value_usd, timestamp)
position_history (wallet, vault_address, shares, value_usd, timestamp)  
vault_registry (address, chain, symbol, asset, protocol, discovered_at)
```

Track position changes over time. Compute PnL from value changes.

---

## DeBank Replacement Analysis

| DeBank Feature | Replacement | Cost |
|----------------|-------------|------|
| Multi-chain token balances | `alchemy_getTokenBalances` on each chain | 75 CU/wallet/chain |
| Protocol position detection | Layer 2 vault registry + `asset()` probe | ~20 CU/token |
| NFT balances | DeBank only (or Alchemy `getNFTs`) | Keep DeBank or drop |
| PnL tracking | Our own position_history table | Free |
| Cross-chain aggregation | Our own orchestrator | Free |
| Wallet labels | DeBank only | Keep if needed |

**Recommendation:** Drop DeBank for position discovery. Keep if you need NFT tracking or wallet labels.

---

## CU Budget Summary

| Task | Frequency | CU/month |
|------|-----------|----------|
| Token balances (150 wallets × 5 chains) | Daily | 56,250 |
| Token metadata (new tokens only) | On discovery | ~10,000 |
| Vault probing (new tokens only) | On discovery | ~5,000 |
| **Total** | | **~71,000** |
| **Free tier** | | **30,000,000** |

We use **0.24%** of the free Alchemy tier. Room to scale 400x before hitting limits.

---

## Build Order

1. **Scanner core** — wire up Alchemy, build the 4-layer pipeline
2. **Vault registry** — seed with Morpho, Euler, Aave token addresses
3. **Enrichment hooks** — wire protocol APIs for APY data
4. **DB schema** — positions + history tables
5. **Dashboard integration** — replace current fetch pipeline
6. **Remove DeBank dependency** — or keep for NFT/labels only

---

## What This Gets Us

For every wallet on every chain:
- **Every token held** (not just vault shares — plain tokens, LPs, gauges, aTokens)
- **Protocol identification** (what vault is this? what's the underlying?)
- **Live APY/rewards** (base + bonus from Merkl, Euler rewards, etc.)
- **Historical tracking** (position changes over time)
- **Scaling** (150 → 1000 wallets is just more Alchemy calls, still free tier)
