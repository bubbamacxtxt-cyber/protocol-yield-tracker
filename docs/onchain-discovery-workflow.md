# Onchain Discovery Workflow

Date: 2026-04-21

## Goal

Define the canonical workflow for onchain wallet discovery and DeBank replacement.

This workflow is for **onchain wallets only**.
Offchain/manual RWA positions remain a separate lane.

## Pipeline

### Lane 0 — wallet inventory
Input:
- `data/whales.json`

Output:
- canonical wallet inventory
- wallet -> entity mapping
- wallet -> vault mapping
- wallet class (`onchain`, `offchain`, `mixed`)

### Lane 1 — DeBank wallet reconnaissance
Purpose:
- discover active chains
- discover rough protocol exposure
- establish reconciliation baseline
- detect missing modeled TVL/protocols
- gate deeper position scanning by wallet+chain activity

Important:
- DeBank is not final onchain truth
- DeBank is discovery + reconciliation + gap-finding
- use one wallet-level positions recon call per wallet, once per day
- there is no separate conceptual chain scan if wallet-level positions recon already gives chains and totals

### Paid daily recon rule
Use one daily DeBank recon call per wallet:
- `GET /v1/user/all_complex_protocol_list?id={wallet}`

Derive from that result:
- wallet+chain totals
- wallet+chain protocol exposure
- threshold gate for deeper scans

### Scan threshold rule
After DeBank wallet recon:
- if `wallet+chain total_usd >= 50000`, mark that wallet+chain as active for deeper position scanning
- if `wallet+chain total_usd < 50000`, do not run expensive position scanning for that wallet+chain
- low-balance chains still remain in future daily recon and reconciliation outputs because whales rotate wallets back in

Outputs:
- `data/recon/debank-wallet-summary.json`
- `data/recon/debank-wallet-positions.json`

### Lane 2 — Alchemy token/vault discovery
Purpose:
- detect direct token balances
- detect vault share balances
- detect issued-asset holdings

Match against:
- `data/stables.json`
- `data/vaults.json`
- token/vault registries

Outputs:
- `data/recon/alchemy-token-discovery.json`
- `data/recon/canonical-token-matches.json`

Important:
- this lane answers what tokenized assets the wallet directly holds

### Lane 3 — protocol API scanner lane
Purpose:
- discover protocol-native positions that token balances alone cannot explain well

Current examples:
- Aave
- Morpho
- Euler
- Spark
- Pendle

Future examples:
- Curve / Convex
- Gearbox
- Silo
- Uniswap
- Dolomite
- Monad leftovers

### Lane 4 — canonical merge / export
Merge precedence:
1. protocol API positions
2. token/vault/YBS discovered positions
3. manual/offchain positions
4. unresolved DeBank fallback only where still missing

Rules:
- YBS/vault lists provide APY/classification for issued assets and vault shares
- YBS/vault lists must not overwrite row-level exposure venue
- row protocol answers where the wallet is actually exposed
- entity/page name answers who the wallet belongs to

### Lane 5 — reconciliation / gap report
Compare:
- DeBank chain/protocol totals
- modeled/exported page totals

Output:
- missing USD by wallet/chain
- missing protocols by wallet/chain
- unresolved gaps to drive next scanner builds

Primary output:
- `data/recon/gap-report.json`

## Hard rules

### DeBank role
Use DeBank for:
- discovery
- reconciliation
- gap-finding

Do not let DeBank remain the silent owner of onchain truth.

### Alchemy role
Use Alchemy for:
- direct token discovery
- direct vault-share discovery

### YBS / vault registry role
Use registries for:
- canonical APY sourcing
- issued-asset classification
- vault-share classification

Do not use registries to rewrite whale row exposure venue.

### Protocol API role
Use protocol APIs for:
- protocol-native position truth

## Immediate build-out

1. build wallet inventory output
2. build DeBank reconnaissance outputs
3. build Alchemy token discovery outputs
4. build canonical token/vault match output
5. build `src/reconcile-gaps.js`
6. generate first machine-readable gap report

## Success condition

The next scanner targets should come from the gap report, not from guesswork.
