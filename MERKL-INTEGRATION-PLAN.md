# Merkl Bonus APY Integration Plan

## Overview

Merkl aggregates incentive campaigns from protocols and communities. We need to:
- Fetch all live campaigns daily
- Parse each campaign's eligibility rules
- Match campaigns to our tracked positions
- Apply bonuses to the correct side (supply or borrow)
- Display as expandable breakdowns on the dashboard

---

## 1. Data Model

### New DB Columns

```sql
ALTER TABLE position_tokens ADD COLUMN bonus_supply_apy REAL DEFAULT NULL;
ALTER TABLE position_tokens ADD COLUMN bonus_supply_source TEXT DEFAULT NULL;  -- e.g. "merkl:ethena-aci"
ALTER TABLE position_tokens ADD COLUMN bonus_borrow_apy REAL DEFAULT NULL;
ALTER TABLE position_tokens ADD COLUMN bonus_borrow_source TEXT DEFAULT NULL;
```

### Net APY Formula (unchanged structure, new calculation)

```
Net APY = Base APY + Bonus Supply APY − Cost APY + Bonus Borrow APY
```

### Dashboard Display

For the main table, keep a single **Net APY** column (color-coded).
When user clicks a row, show an expanded breakdown:

```
┌─────────────────────────────────────────┐
│ Supply:  Base 1.00%  +  Bonus 3.06%    │
│ Borrow:  Cost 3.87%  −  Bonus 0.00%    │
│ ─────────────────────────────────────── │
│ Net:     1.00 + 3.06 − 3.87 + 0 = 0.19%│
│                                         │
│ Bonus Source: Merkl — Ethena Liquid     │
│ Leverage (sUSDe + USDe, min amount)     │
└─────────────────────────────────────────┘
```

---

## 2. Merkl Campaign Parsing

### Campaign Types & Matching Rules

Each Merkl campaign has a `type` field that determines how to match it:

| Type | Action | Matching Logic |
|------|--------|----------------|
| `ERC20LOGPROCESSOR` | LEND/BORROW | Single token bonus. Match token address directly. |
| `MORPHOSUPPLY_SINGLETOKEN` | LEND | Single token supply on Morpho. Match token + chain. |
| `MORPHOVAULT` | LEND | Vault supply on Morpho. Match vault address. |
| `AAVE_NET_LENDING` | LEND | Net supply on Aave. Bonus applies to (supply − borrow) amount. |
| `DOLOMITE_NET_LENDING` | LEND | Net supply on Dolomite. Same as above. |
| `EULER` | LEND/BORROW | Euler-specific. Match token + subaccount. |
| `MULTILOG_DUTCH` | LEND/BORROW | **Complex** — must parse description for rules. |

### Parsing MULTILOG_DUTCH Rules

These campaigns have free-text descriptions with specific conditions. We need to extract:

#### Pattern 1: "lowest/minimum of X and Y"
```
Example: "The campaign considers the lowest amount of tokens lent 
         across the sUSDe and USDe markets"
         
Parsed: min(sUSDe_amount, USDe_amount) → bonus applied to USDe only
```

#### Pattern 2: "must also borrow Z"
```
Example: "To be eligible, users must also borrow USDC, USDT, or USDS"
         
Parsed: AND(position has borrow of USDC OR USDT OR USDS)
```

#### Pattern 3: "health factor below X"
```
Example: "maintain a health factor below 2.5"
         
Parsed: AND(position.health_rate < 2.5)
```

#### Pattern 4: "bonus applies to [token]"
```
Example: (implicit) bonus is applied to the collateral/supply side
        
Parsed: Bonus → supply side
```

### Rule Parser (conceptual)

```
parseMerklRules(campaign) → {
  eligibleTokens: [address1, address2, ...],  // tokens that qualify
  requiredTokens: [address1, ...],            // must also have these
  requiredBorrows: [address1, ...],           // must also borrow these
  maxHealthFactor: null | 2.5,                // HF constraint
  minOfTokens: [address1, address2] | null,   // bonus on min of these
  bonusSide: 'supply' | 'borrow',
  bonusAppliesTo: address | null,             // which token gets the bonus
}
```

---

## 3. Matching Engine

### For Each Position

```
For each position (wallet, chain, protocol, role, token, amount):
  
  1. Find all Merkl campaigns matching:
     - chainId = position.chain_id
     - protocol.id = position.protocol_id (mapped)
     - action matches role (LEND→supply, BORROW→borrow)
     - status = LIVE
     - token in campaign's eligibleTokens
  
  2. For each matching campaign, check conditions:
     - If requiredBorrows: does this wallet have a borrow of one of those tokens?
     - If maxHealthFactor: is position.health_rate < maxHF?
     - If requiredTokens: does this wallet supply all required tokens?
  
  3. Calculate bonus amount:
     - If minOfTokens: bonus = APR × min(supply_usd of each token)
     - If bonusAppliesTo: bonus = APR × position amount (only this token gets it)
     - If AAVE_NET_LENDING: bonus = APR × (supply_usd − borrow_usd)
     - Otherwise: bonus = APR × position.usd_value
  
  4. Store in DB:
     - If LEND: bonus_supply_apy += APR
     - If BORROW: bonus_borrow_apy += APR
     - Source: "merkl:campaign-slug"
```

### Cross-Wallet Conditions

For campaigns requiring BOTH sUSDe AND USDe:
- Check if the same WALLET has positions in both tokens
- If wallet has both: apply bonus to USDe position (on min amount)
- If wallet only has USDe: apply full bonus to USDe
- If wallet only has sUSDe: NO bonus (doesn't meet "both" requirement)

This requires joining positions by wallet address during matching.

### Protocol ID Mapping

| Our Protocol Name | Merkl `protocol.id` |
|-------------------|---------------------|
| Aave V3 | `aave` |
| Morpho | `morpho`, `morpho-blue` |
| Euler | `euler`, `euler-v2` |
| Venus | `venus` |
| Spark | `spark` |
| Silo | `silo-finance` |
| Fluid | `fluid` |
| Curve | `curve` |
| Convex | `convex` |
| Pendle | `pendle` |

### Chain ID Mapping

| Our Chain | Merkl `chainId` |
|-----------|-----------------|
| eth | 1 |
| arb | 42161 |
| base | 8453 |
| plasma | 9745 |
| mnt | 5000 |
| sonic | 146 |
| bsc | 56 |
| monad | 143 |
| hyper | 999 |

---

## 4. Implementation Files

### `src/fetch-merkl.js` (new)

```
Main function: fetchMerklBonuses()

Steps:
1. For each chain, fetch all live opportunities:
   GET /v4/opportunities?chainId={id}&items=100&page={n}
   
2. Filter to our protocols (aave, morpho, euler, venus, spark, etc.)
   OR just fetch all and filter later (Merkl has ~200 live campaigns)

3. Parse rules from each campaign:
   - Read description, name, type
   - Extract: eligibleTokens, requiredBorrows, maxHF, minOfTokens, bonusSide

4. Read all positions from DB:
   SELECT pt.*, p.wallet, p.chain, p.protocol_name, p.position_index
   FROM position_tokens pt 
   JOIN positions p ON pt.position_id = p.id
   WHERE pt.role = 'supply' OR pt.role = 'borrow'

5. For each position, match against campaigns and calculate bonus:
   - Store bonus_supply_apy and bonus_borrow_apy
   - Store source string

6. Return { supplyBonusCount, borrowBonusCount, totalBonusUsd }
```

### `src/export.js` (modify)

After exporting data.json, recalculate net APY:
```javascript
for (const pos of allPositions) {
  const base = pos.apy_base || 0;
  const bonusSupply = pos.bonus_supply_apy || 0;
  const cost = pos.apy_cost || 0;
  const bonusBorrow = pos.bonus_borrow_apy || 0;
  pos.apy_net = base + bonusSupply - cost + bonusBorrow;
}
```

### `template.html` (modify)

Add expandable row detail:
- Click row → show breakdown card with base/bonus/cost/bonus-borrow
- Include source attribution

### `.github/workflows/update.yml` (modify)

Add Merkl step after base APY fetch:

```yaml
- name: Fetch Merkl incentives
  run: node src/fetch-merkl.js
```

Schedule order:
- 06:00 UTC: YBS tokens
- 06:30 UTC: Full whale + vault scan (DeBank)
- 07:00 UTC: Base APY fetch
- **08:00 UTC: Merkl incentives**

---

## 5. Edge Cases

| Case | Handling |
|------|----------|
| Expired campaign | Filter by `status = LIVE` and `latestCampaignEnd > now` |
| No Merkl data for chain | Gracefully skip — bonus stays NULL |
| Multiple campaigns same token | Sum all matching APRs |
| Campaign requires untracked token | Skip — position doesn't qualify |
| HF condition but position has no borrow | If maxHF required, skip (no HF to check) |
| "Min of X and Y" but only one tracked | Apply full bonus to tracked token (best effort) |
| Vault address vs token address | Use `explorerAddress` from campaign to match vault positions |
| Campaign type unknown | Log warning, skip |

---

## 6. What Could Go Wrong

| Risk | Impact | Mitigation |
|------|--------|------------|
| Merkl API changes/breaks | No bonus data | Graceful error handling, log but don't fail workflow |
| Rule parsing misinterprets conditions | Wrong bonus applied | Start with clear rules only, flag ambiguous campaigns with `merkl:unverified` prefix |
| Token address mismatch | Missing matches | Use both address (lowercased) AND symbol as fallback |
| Campaign APR spikes briefly | Skewed net APY | Daily snapshot is acceptable for bonus incentives |
| Multi-token rule applied wrong | Over/under-counting | Handle "min of X and Y" as priority case, test with real data |
| Protocol name not mapped | Missing campaigns | Maintain mapping table, add new protocols as Merkl adds them |
| Position has null token address | Can't match | Log warning, skip |

---

## 7. Testing Strategy

1. **Dry run** — fetch Merkl data, log matches without writing to DB
2. **Spot check** — verify known campaigns (Ethena on Aave, USDT0 on Plasma) match correctly
3. **Edge case tests** — positions with only sUSDe (should NOT get Ethena bonus if "both required")
4. **Cross-check** — compare bonus APYs against Merkl's website for known positions
5. **Dashboard verification** — confirm breakdown renders correctly

---

## 8. Implementation Order

1. **Schema** — add `bonus_supply_apy`, `bonus_borrow_apy`, `bonus_*_source` columns
2. **Fetcher** — `fetch-merkl.js` with rule parsing
3. **Matcher** — match campaigns to positions, calculate bonuses
4. **Exporter** — recalculate net APY with bonuses
5. **Template** — expandable row breakdown
6. **Workflow** — add Merkl step at 8am UTC
7. **Test** — dry run, spot check, verify

---

## 9. Open Questions

| Question | Current Thinking |
|----------|------------------|
| How to handle campaigns we can't fully parse? | Prefix source with `merkl:*` to flag unverified |
| Should we store campaign names in DB? | Yes — in `bonus_*_source` for traceability |
| What if bonus is 0% (campaign exists but rate is 0)? | Store 0, not NULL (campaign exists but rate is 0) |
| Priority of multiple campaigns on same token? | Sum all — they stack |
| Should we show individual campaign breakdowns in expanded view? | Yes — list each bonus source + amount |
