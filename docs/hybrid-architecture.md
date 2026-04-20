# Hybrid Scanner Architecture

_Updated: 2026-04-20_

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Position Discovery                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 1: Protocol Scanners (PRIMARY)                       │
│  ─────────────────────────────────────                      │
│  • Aave scanner: Aave V3 positions (all chains)             │
│  • Morpho scanner: Morpho vaults + market positions          │
│  • Euler scanner: Euler v2 vault positions                   │
│  • Fluid scanner: Fluid lending positions                    │
│                                                              │
│  Coverage: ~65% of TVL ($600M+)                             │
│  Pros: Complete position data, APY, leverage                │
│  Cons: Only covers lending protocols                        │
│                                                              │
│  Layer 2: DeBank API (GAP FILL)                             │
│  ─────────────────────────────────────                      │
│  • Ethena staking (sUSDe, sENA)                             │
│  • RWA / Private deals (Fasanara, FalconX)                  │
│  • Pendle PT/YT positions                                   │
│  • Other protocols not covered by scanners                  │
│                                                              │
│  Coverage: ~35% of TVL ($465M)                              │
│  Cost: ~$0/month (well under 10M unit free tier)            │
│                                                              │
│  Layer 3: Alchemy (FALLBACK)                                │
│  ─────────────────────────────────────                      │
│  • Only used if DeBank fails                                │
│  • Basic token balance queries                              │
│  • ERC-4626 vault detection                                 │
│                                                              │
│  Limitation: alchemy_getTokenBalances not supported on       │
│  all chains (e.g., plasma). Protocol positions may not       │
│  be in Alchemy's token registry.                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## TVL by Source (2026-04-20)

| Source | TVL | Positions | % of Total |
|--------|-----|-----------|------------|
| Protocol scanners | $600M+ | 140+ | ~60% |
| DeBank | $465M | ~60 | ~40% |
| **Total** | **$1.065B** | **184** | **100%** |

## DeBank is Cheap and Still Needed

- Current usage: ~0.9M units/month (10M included in $299/mo plan)
- **Cost: $0** (well under free tier)
- Provides essential data for non-lending protocols
- Keep as gap-filler, not primary source

## Recommendation

**Keep current hybrid architecture.** Don't replace DeBank entirely — our protocol scanners already handle lending positions better than DeBank. DeBank fills gaps for RWA, staking, and exotic positions at essentially zero cost.

The "Alchemy fallback" (P1 #6) should only be:
- If DeBank API returns errors → use protocol scanners only
- If DeBank credits exhausted → use protocol scanners only
- Alchemy is NOT a full DeBank replacement for protocol positions
