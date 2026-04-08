# Protocol Yield Tracker — Architecture & Operations

> **Purpose:** Comprehensive system documentation. Read this first to understand how everything works.
> 
> **Last Updated:** 2026-04-08

---

## 1. System Overview

We track 11 "whale" protocols (mezzanine DeFi platforms) across 9 chains, scanning their positions in underlying protocols (Aave, Morpho, Euler, etc.) to get total value, health factors, and APYs.

**Live:** https://bubbamacxtxt-cyber.github.io/protocol-yield-tracker/
**Workflow:** DeBank scan → InfiniFi/Anzen/Pareto API fetch → export to data.json → GitHub Pages dashboard
**Schedule:** Daily at 7:30 AM UTC

---

## 2. All Data Sources

### 2.1 DeBank Cloud API (Primary — scans 8 whales)
- `DEBANK_API_KEY stored in GitHub Actions secrets`
- Covers 1000+ protocols across 50+ chains
- Used for: Avant, yoUSD, Yuzu, Reservoir, Makina, Upshift, Midas, Superform
- NOT used for: InfiniFi, Anzen, Pareto (these have dedicated fetchers)

**Endpoints & Cost:**
| Endpoint | Cost | Use |
|----------|------|-----|
| `/v1/user/used_chain_list` | 2 units/wallet | Discover active chains |
| `/v1/user/chain_balance` | ~1 unit/wallet/chain | Pre-filter (skip chains <$50K) |
| `/v1/user/complex_protocol_list` | 10 units/wallet/chain | Full position scan |
| `/v1/user/token_list` | ~1 unit | Wallet-held tokens (balance verification) |

**Budget:** 1M units = $200. ~$200 remaining (151K used in dev). ~$0.23/day at daily scans = 745+ days runway.

### 2.2 InfiniFi API (1 whale)
- `https://eth-api.infinifi.xyz/api/protocol/data` — free, no auth
- Also fetches Plasma data from same endpoint or separate endpoint
- Data merged into data/whales/infinifi.json then exported

### 2.3 Anzen API + On-chain (1 whale)
- `https://rwa-api.anzen.finance/collaterals` — commitments (free, no auth)
- On-chain USDz total supply for MMZ residual calculation
- Merged into data/whales/anzen.json

### 2.4 Pareto — On-chain queue contract (1 whale)
- `ParetoDollarQueue` at `0xA7780086ab732C110E9E71950B9Fb3cb2ea50D89` on Ethereum
- On-chain `getTotalCollateralsScaled()` for sUSP total
- `https://app.pareto.credit/api/v1/vault-blocks` for APYs
- Merged into data/whales/pareto.json

### 2.5 DeFiLlama Yield API (stables table only)
- `https://yields.llama.fi/pools` — free, no auth
- Used ONLY for yield-bearing stables APR display
- 33 tokens tracked

---

## 3. Database Schema (SQLite — yield-tracker.db)

### positions table
```sql
CREATE TABLE positions (
    id INTEGER PRIMARY KEY,
    wallet TEXT NOT NULL,
    chain TEXT NOT NULL,
    protocol_id TEXT NOT NULL,
    protocol_name TEXT,
    position_type TEXT,
    strategy TEXT,
    yield_source TEXT,
    health_rate REAL,
    net_usd REAL,
    asset_usd REAL,
    debt_usd REAL,
    position_index TEXT,
    debank_updated_at TEXT,
    scanned_at TEXT DEFAULT (datetime('now')),
    UNIQUE(wallet, chain, protocol_id, position_index)
);
```

### position_tokens table
```sql
CREATE TABLE position_tokens (
    id INTEGER PRIMARY KEY,
    position_id INTEGER REFERENCES positions(id),
    role TEXT,          -- 'supply', 'borrow', 'reward'
    symbol TEXT,
    real_symbol TEXT,
    real_name TEXT,
    cg_id TEXT,
    address TEXT,
    amount REAL,
    price_usd REAL,
    value_usd REAL
);
```

### token_registry table
```sql
CREATE TABLE token_registry (
    address TEXT,
    chain TEXT,
    symbol TEXT,
    real_symbol TEXT,
    real_name TEXT,
    cg_id TEXT,
    cg_price_usd REAL,
    source TEXT
);
```

---

## 4. Dedup & Cleanup Logic (CRITICAL)

### The Problem
DeBank reports the same position differently across scans (position_index changes), causing duplicate entries in the database.

### The Fix: DELETE old positions AFTER scan completes
**File:** `src/fetch.js`, end of main()

```javascript
// Record scan start time (MUST use SQLite datetime format, NOT ISO)
const scanStart = db.prepare("SELECT datetime('now') as t").get().t;

// ... scan all wallets, insert positions ...

// Clean up old positions (MUST delete tokens first due to FK constraint)
const oldIds = db.prepare('SELECT id FROM positions WHERE scanned_at < ?').all(scanStart).map(r => r.id);
if (oldIds.length > 0) {
    const idPlaceholders = oldIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM position_tokens WHERE position_id IN (${idPlaceholders})`).run(...oldIds);
    const deleted = db.prepare('DELETE FROM positions WHERE scanned_at < ?').run(scanStart).changes;
    console.log(`Cleaned ${deleted} old position entries`);
}
```

### CRITICAL GOTCHAS (must never be changed):
1. **scanStart MUST use SQLite datetime format** — `db.prepare("SELECT datetime('now') as t").get().t`
   - Returns: `2026-04-08 07:45:00` (space separator)
   - NEVER use `new Date().toISOString()` — returns `2026-04-08T07:45:00.000Z` (T separator)
   - SQLite string comparison: `'T' (84) > ' ' (32)`, so ISO format sorts HIGHER
   - If scanStart uses ISO, cleanup thinks fresh positions are OLD and deletes them!
   - This caused runs #24-26 to fail (all data deleted after scan)

2. **position_tokens MUST be deleted before positions** (foreign key constraint)
   - position_tokens has FK reference to positions(id)
   - Cannot delete positions while tokens still reference them

3. **Keep old data visible during scan** (never delete BEFORE scan)
   - Old positions stay in DB during scan
   - Dashboard still shows data while scanning
   - Only cleaned AFTER fresh data is inserted

4. **No dedup in export.js** — the DB is cleaned at scan time, export just reads everything
   - Old code had export-time dedup (was wrong, removed duplicates)
   - Now: export reads all positions from clean DB

---

## 5. Validation System

**File:** `src/validate.js` — runs in GitHub Actions after export, before push

### 5.1 Source Validation (0% tolerance — exact match)
Compares data.json totals vs DB totals per whale:
- Groups positions by wallet, sums net_usd
- Must match exactly (0.1% tolerance for rounding)
- Skips manual-only whales (InfiniFi, Anzen, Pareto)
- Catches: export bugs, data loss, dedup errors

### 5.2 API Validation (5% tolerance)
Compares specific whales against live APIs:
- **InfiniFi:** data.json vs `https://eth-api.infinifi.xyz/api/protocol/data`
- **Pareto:** data.json vs on-chain `getTotalCollateralsScaled()`
- Pareto uses 15% tolerance (on-chain includes unallocated funds)
- Anzen skipped (USDz supply fluctuates too much)

### 5.3 Failure Behavior
- If validation fails, workflow aborts (no push to GitHub Pages)
- Telegram alert sent to Saus with run link
- `process.exit(1)` — no commit

---

## 6. GitHub Actions Workflow

**File:** `.github/workflows/update.yml`

### Schedule
- Daily at **7:30 AM UTC** (changed from 10:00 AM)
- Manual trigger via `workflow_dispatch`

### Steps
1. `actions/checkout@v4`
2. `actions/setup-node@v4` (Node 20)
3. `npm ci`
4. **Scan DeBank wallets** — `node src/fetch.js` (DEBANK_API_KEY from secrets)
5. **Fetch InfiniFi** — `node src/fetch-infinifi.js`
6. **Fetch Anzen** — `node src/fetch-anzen.js`
7. **Fetch Pareto** — `node src/fetch-pareto.js`
8. **Fetch Stables** — `node src/fetch-stables.js` (DeFiLlama)
9. **Export** — `node src/export.js` → data.json + total-history.json
10. **Validate** — `node src/validate.js` (fails if >5% drift)
11. **Alert on failure** — sends Telegram message if validation fails
12. **Commit & push** — `stefanzweifel/git-auto-commit-action@v5`

### File Pattern (what gets committed)
```
data/whales/ data/manual-positions.json data/stables.json data/total-history.json data.json yield-tracker.db
```

### Secrets Required
| Secret | Value |
|--------|-------|
| `DEBANK_API_KEY` | DeBank API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Saus's Telegram user ID |

### Telegram Alert
- Bot: Yield worker bot (@Yield_worker_bot)
- Saus user ID: `6141197493`
- Message: "⚠️ Whale data validation failed! Run #XX" + link to actions run

---

## 7. Dashboard Features

### Index.html (Homepage)
- **Summary cards:** Total Value, Avg APY, Total Positions, Active Whales
- **Allocation chart:** Doughnut chart (top 8 protocols)
- **Chain chart:** Bar chart (value by chain)
- **Yield Bearing Stables:** Scrollable table with 33 tokens, sortable columns (Token, APR, TVL)
- **Daily/Weekly change:** Shows `+X.XX% day · +X.XX% week` next to "Last updated"
- **Whale cards:** Click to navigate to whale detail pages
- **Cache busting:** `?t=Date.now()` on all data fetches

### Whale Detail Pages (template.html)
- **8 summary cards:** Net Value, Total Assets, Total Debt, Avg Health, Wallets, Positions, Top Protocol, Top Chain
- **Filters:** Chain, Protocol, Search, Min $
- **Table:** Wallet, Chain, Protocol, Type, Strategy, HF, Supply, Borrow, Net USD, Assets, Debt
- **Download XLSX** button
- **Color scheme:** Metallic blue gradient on cards, dark blue buttons

### Vault Detail Pages
- Sub-pages for multi-vault whales (Makina, Midas, Upshift, Superform)
- Same design as whale pages
- Located in subdirectories: `makina/`, `midas/`, `upshift/`, `superform/`

### Health Factor Display
- Uses `fmtHF()` function: `Number(n).toExponential(3).split("e")[0]`
- Handles both normal values (1.024 → "1.024") and extreme values (1.15e+59 → "1.158")
- Color coding: green ≥1.15, yellow <1.15, red <1.05

### Known Dashboard Gotcha
- `render()` function MUST be `async function render()` — uses `await` for history fetch
- If not async → SyntaxError → entire dashboard blank

---

## 8. Current Whales

| Whale | Source | Wallets | Expected Positions | Notes |
|-------|--------|---------|--------------------|-------|
| Avant | DeBank | 5/20 | 12-14 | Large Aave V3 positions on ETH + Plasma |
| yoUSD | DeBank | 1/1 | 6-9 | Single wallet, multiple Morpho markets |
| Yuzu | DeBank | 9/10 | 27-28 | Multiple wallets, Aave V3 + Morpho |
| Reservoir | DeBank | 4/4 | 9 | Euler + Morpho + Aave V3 |
| Makina | DeBank | 2/2 | 16-17 | Multi-vault: Dialectic + Steakhouse |
| Upshift | DeBank | 3/3 | 14-15 | Multi-vault: Core USDC + earnAUSD + singularV |
| Midas | DeBank | 6/6 | 38 | Multi-vault: mHyper + mMev + mAPOLLO |
| Superform | DeBank | 1/1 | 3-6 | Single vault |
| InfiniFi | API | — | 14 | Manual RWA data from API |
| Anzen | API + on-chain | 1/1 | 5 | USDz total supply - API commitments = MMZ |
| Pareto | On-chain | 1/1 | 4 | sUSP vault allocations from queue contract |

---

## 9. Known Issues & Workarounds

### 9.1 Cloudflare Rate Limiting
- **NEVER** use web_fetch or curl on CF-protected sites
- Pattern: Fetch homepage once → extract JS bundle URLs → grep for API endpoints
- No path brute-forcing (will get IP blocked)
- Rate limit: 1 req/sec max, burst max 10

### 9.2 Position Index Changes Between Scans
- DeBank returns different position_index formats for same position
- Cleanup uses `scanned_at < scanStart` (not position_index) to identify old data
- This catches duplicates regardless of position_index changes

### 9.3 $50K Minimum Threshold
- `MIN_NET_USD = 50000` in fetch.js
- Positions below $50K are excluded from scan
- Balance pre-filter uses same threshold
- Wallet-held tokens ("naked tokens") not tracked on dashboard

### 9.4 Source Validation vs DeBank Filtering
- Source validation compares data.json vs DB — should always match (0%)
- $50K filter applies to BOTH equally (no effect on validation)
- Naked tokens excluded from BOTH (no effect on validation)

---

## 10. Run History (2026-04-08)
- **Run #23:** Success — but still had duplicates (cleanup used ISO format, deleted fresh data)
- **Run #24:** Failure — FK constraint error during cleanup
- **Run #25:** Failure — all whales $0 (cleanup deleted fresh data)
- **Run #26:** Failure — all whales $0 (same datetime bug)
- **Run #27:** SUCCESS — fixed datetime format ($662M, 134 positions)

### Final Fixes
1. scanStart uses `datetime('now')` (SQLite format) not `toISOString()`
2. position_tokens deleted before positions (FK constraint)
3. Cleanup runs AFTER scan, not before (keeps data visible during scan)
4. Removed export-time dedup (DB is already clean)
5. Made `render()` async (was causing SyntaxError)
