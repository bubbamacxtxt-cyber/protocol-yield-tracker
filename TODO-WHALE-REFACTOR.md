# Whale Page Refactor: COLUMNS/CARDS Config Pattern

## Goal
Roll out the single-source-of-truth pattern (from Anzen refactor) to all whale pages.
Table columns and summary cards both derive from `COLUMNS` config — change field mapping once, both update.

## Pattern
```javascript
const COLUMNS = [
  { key: 'protocol', field: 'asset_type', fallback: 'protocol_name' }, // ← only this changes per whale
  { key: 'supply',   field: 'protocol_name' }, // or 'underlying' etc
  ...
];
const CARDS = [
  { label: 'Top Protocol', field: 'protocol', aggregate: 'top', ... }, // references COLUMNS key
  ...
];
```

## Whales to Update

| Whale | Protocol Field | Supply Field | Has Borrow | Has Health | Special Notes |
|-------|---------------|--------------|------------|------------|---------------|
| **Anzen** | `asset_type` → SMB Financing etc | `protocol_name` (bond IDs) | ❌ | ❌ | ✅ Done |
| **Pareto** | `asset_type` → DeFi, HF Trading etc | `protocol_name` | ❌ | ❌ | Similar to Anzen |
| **InfiniFi** | `protocol_name` | `supply.symbol` | ❌ | ❌ | RWA + lend mix |
| **Midas** | `protocol_name` | `supply.symbol` | ✅ | ✅ | Complex, most positions |
| **Avant** | `protocol_name` | `supply.symbol` | ✅ | ✅ | Loop + lend |
| **Yuzu** | `protocol_name` | `supply.symbol` | ✅ | ✅ | Multi-strategy (5 types) |
| **Upshift** | `protocol_name` | `supply.symbol` | ✅ | ✅ | Yield + loop |
| **Makina** | `protocol_name` | `supply.symbol` | ✅ | ✅ | Farm + stake |
| **Reservoir** | `protocol_name` | `supply.symbol` | ❌ | ✅ | Lend only |
| **yoUSD** | `protocol_name` | `supply.symbol` | ❌ | ❌ | Lend only |
| **Superform** | `protocol_name` | `supply.symbol` | ❌ | ❌ | Only 2 positions |

## Approach
1. **Extract to shared module**: Move COLUMNS/CARDS/getFieldValue/renderers to a `whale-common.js` that each page includes
2. **Per-whale config**: Each page only defines its specific COLUMNS and CARDS overrides
3. **One at a time**: Start with Pareto (similar to Anzen), then Midas (complexest), then the rest
4. **Update rebuild-pages.js**: Generate pages from template + per-whale config instead of inline

## Benefits
- Field mapping changes propagate to both table + cards automatically
- New whale pages: just define config, rendering engine is shared
- Template updates (styles, new card types) apply to all whales at once

## When
- Low priority — Anzen proves the pattern works
- Do alongside any template/style changes
- Could be part of larger dashboard v2 if we go that route
