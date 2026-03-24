# Whale Page Template

## How to Add a New Whale

### 1. Get Wallet Addresses
- Receive list of wallet addresses from Saus
- Add to `data/wallets.json` (or create new file per whale if separate)

### 2. Run Scanner
```bash
DEBANK_API_KEY="<key>" node src/fetch.js
```
This scans all wallets and saves positions to `yield-tracker.db`.

### 3. Export Data
```bash
node src/export.js
```
This generates `data.json` for the dashboard.

### 4. Create Whale Page
Copy `template.html` → `{whale-name}.html` (lowercase, hyphens for spaces)

Edit ONLY these lines in the new file:
- Line 3: `<title>` — change to whale name
- Line ~12: `<h1>` — change to whale name
- Line ~13: `<p class="subtitle">` — change description if needed
- Line ~28: `getWhale()` function — change `'Avant'` to the whale's key in data.json

### 5. Add to data.json
In `src/export.js`, add the whale to the whales object:
```javascript
const whales = {
    'Avant': { name: 'Avant', wallets: avantWallets, ... },
    'NewWhale': { name: 'NewWhale', wallets: newWallets, ... }
};
```

Or manually add to the `whales` object in the exported `data.json`.

### 6. Commit & Push
```bash
git add -A && git commit -m "Add {whale-name} protocol" && git push origin main
```

### 7. Verify
- Home page (`index.html`) shows the new whale
- Whale page (`{name}.html`) loads with correct data
- XLSX download works
- DeBank profile links work

## File Naming Convention
- Home page: `index.html`
- Whale pages: `{whale-name}.html` (lowercase, hyphens)
  - Examples: `avant.html`, `wintermute.html`, `galaxy-digital.html`

## Template Checklist
Every whale page MUST have:
- [ ] ← Home button linking to `index.html`
- [ ] Whale name as `<h1>`
- [ ] Subtitle describing the whale
- [ ] 6 summary cards (Net Value, Total Assets, Total Debt, Avg Health, Wallets, Positions)
- [ ] Protocol summary chips
- [ ] Filters (Protocol, Chain, Strategy, Min $)
- [ ] XLSX download button
- [ ] Position table with all columns
- [ ] Wallet addresses as DeBank profile links
- [ ] Health factor color coding (🔴 <1.05, 🟡 <1.15, 🟢 >1.15)
- [ ] Strategy badges
- [ ] Footer with generation timestamp

## Data Flow
```
Wallet addresses → DeBank API → SQLite DB → data.json → Whale HTML page
                                                   → data-{whale}.csv (XLSX download)
```
