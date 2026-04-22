# DefiLlama Adapter Reconnaissance (2026-04-22)

For each tracked whale, pulled the DefiLlama adapter source and diffed
against our `data/whales.json`. Goal: find wallets DefiLlama uses that
we aren't tracking.

## Summary by whale

| Whale | DL Addrs | Our Addrs | In DL + Ours | Missing (DL-only) | Extra (Ours-only) |
|---|---|---|---|---|---|
| Reservoir | 1 | 4 | 0 | 1 | 4 |
| Re Protocol | 17 | 14 | 14 | 3 | 0 |
| Upshift | 5 | 3 | 0 | 5 | 3 |
| Superform | 22 | 1 | 0 | 22 | 1 |
| Makina | 4 | 2 | 0 | 4 | 2 |
| InfiniFi | 1 | 9 | 0 | 1 | 9 |
| Yuzu | 3 | 10 | 1 | 2 | 9 |
| Avant | 1 | 20 | 0 | 1 | 20 |
| yoUSD | 5 | 1 | 1 | 4 | 0 |

## Details per whale

### Reservoir
Adapter: `reservoir/index.js` — uses just the **reUSD token on Avalanche**
at `0x1a49bc8464731a08c16edf17f33cf77db37228a4` and takes its
`totalSupply()`. Not a wallet, it's the token contract for TVL.
→ Not relevant to our wallet tracking. The 4 addresses we already
track are the actual Reservoir whale wallets on other chains.

### Re Protocol
Adapter: `re-protocol/index.js` — explicit custodian + contract addresses
per chain (ethereum/avax/arbitrum/base) with labeled comments.

**Missing from our list (all Avalanche-side):**
- `0x4f1ff9b995472b27a6bafec967986f35bf1adae4` — avax redemptions wallet (EOA, no tokens)
- `0xc79a363a3f849d8b3f6a1932f748ea9d4fb2f607` — avax redemptions contract (holds latestAnswer oracle data, not token balances)
- `0x3094948b3dbe89f4824217e37b8667fbb4d89e18` — avax reUSD contract? (empty EOA)

→ These are **Avalanche side contracts**, not whale-held wallets with
positions. No balance, skip.

### Upshift
Adapter pulls vault list dynamically from `api.augustdigital.io`.
Live API shows **56 EVM vaults** across 10 chains (we only track 3).

**Missing (sample of 56):**
- chain 1 (ethereum): 39 vaults — e.g. `0x0243755a22E37b835486fdAE9A839523ADABd336`, `0xA422C3018C46ba90a14AcD14f96CB60616F5c91B`, `0x3299A525986D2e94B3FC6c641C158f5e12dB912d`, ...
- chain 8453 (base): 4 vaults — e.g. `0x4e2D90f0307A93b54ACA31dc606F93FE6b9132d2`
- chain 143 (monad): 11 vaults
- chain 999 (hyperliquid): 6 vaults
- chain 43114 (avax): 4 vaults
- chain 57073 (ink): 1 vault
- chain 9745 (plasma): 1 vault
- chain 31612 (mezo): 1 vault
- chain 14 (flare): 1 vault

→ **Major coverage gap**. Our Upshift tracking is ~5% of DefiLlama's
known vault list. Fix by replacing static whales.json entry with a
dynamic fetch from `api.augustdigital.io/api/v1/tokenized_vault` and
scanning each vault's totalAssets().

### Superform
Adapter `superform/index.js` — discovers vaults from Superform factory
contract. The 22 addresses I extracted from the adapter are actually
**blacklistedVaults** (explicitly EXCLUDED from TVL), plus one fantom
factory. Not useful.

→ The correct discovery path is the Superform factory contract. To
match DefiLlama, scan factory events for registered vaults. Separate
work — can skip for now.

### Makina
Adapter `makina-finance/index.js` — 4 addresses on Ethereum. All 4
respond as empty EOAs / non-responsive contracts right now.

**Missing:**
- `0x1e33e98af620f1d563fcd3cfd3c75ace841204ef`
- `0x871ab8e36cae9af35c6a3488b049965233deb7ed`
- `0x972966bcc17f7d818de4f27dc146ef539c231bdf`
- `0xac499adf00a54044b988a59b19016655c3494b06`

→ Worth re-checking the adapter itself to understand what it's reading
from these addresses. Their names aren't commented in the source.

### InfiniFi
Adapter `infiniFi/index.js` — only **one** address:
- `0x7a5c5dba4fbd0e1e1a2ecdbe752fae55f6e842b3`

This is InfiniFi's **main vault contract** on Ethereum. We currently
track 9 related whale wallets but NOT this vault address itself.

→ **Worth adding** — this might be how we recover the missing $3.58M
from InfiniFi 55% coverage. Need to check its totalAssets().

### Yuzu
Adapter `yuzu-money/index.js` — 3 token contracts on Plasma chain.

**Missing:**
- `0xc8a8df9b210243c55d31c73090f06787ad0a1bf6` — **syzUSD** (Staked Yuzu USD) totalSupply = 46.4M on Plasma
- `0xebfc8c2fe73c431ef2a371aea9132110aab50dca` — **yzPP** (Yuzu Protection Pool) totalSupply = 3.5M on Plasma

→ These are **the Yuzu protocol tokens themselves**, not wallets.
Tracking their totalSupply is the correct protocol-TVL method (like we
do for YO). But we already track 10 Yuzu whale wallets, so we're
capturing from the holder side, not the issuer side. Pick one view.

### Avant
Adapter `avant/index.js` — just the **avUSD token on Avalanche**:
- `0x24de8771bc5ddb3362db529fc3358f2df3a0e346` — totalSupply = $122.5M on avax

This is the avUSD token contract for TVL. Not a whale wallet.
→ Our Avant tracking uses 20 whale wallets. Don't add this token.

### yoUSD (reverted to just yoUSD vault)
Adapter `yo/index.js` — 5 vault addresses (yoUSD, yoETH, yoBTC, yoEURC,
yoGOLD).

**Missing** (4 — we intentionally only track yoUSD now per Saus):
- `0x3a43aec53490cb9fa922847385d82fe25d0e9de7` — yoETH vault
- `0xbcbc8cb4d1e8ed048a6276a5e94a3e952660bcbc` — yoBTC vault
- `0x50c749ae210d3977adc824ae11f3c7fd10c871e9` — yoEURC vault
- `0x586675a3a46b008d8408933cf42d8ff6c9cc61a1` — yoGOLD vault

→ Intentionally excluded. If ever tracking YO Protocol as a whole,
re-add these. Current mode: yoUSD only.

## Flags / action items

1. **Upshift** — biggest gap. We track 3 of 56 known vaults (~$50M of
   $50M DeBank, so coincidentally matches despite missing 53 vaults).
   Next: point at the August Digital API for dynamic discovery.

2. **InfiniFi** — single missing address `0x7a5c...` is the main
   infiniFi vault. Worth balance-checking to see if it closes the
   $3.58M coverage gap.

3. **Makina** — 4 unlabeled Ethereum addresses. Re-read adapter to
   understand what `totalAssets()` path they use.

4. **Re Protocol** — 3 missing Avax-side addresses confirmed to be
   empty redemption contracts. No action.

5. **Yuzu / Avant / Reservoir** — DefiLlama adapter values the protocol
   token's totalSupply on a stablecoin chain. We value the whale wallets
   that hold/deployed those tokens. Different methodologies but both
   valid. No action unless we want to cross-check issuer-side vs
   holder-side coverage.

## How reconnaissance was performed

Script: `scripts/check-missing-addrs.js` — for each non-tracked DL
address, called totalSupply(), totalAssets(), symbol(), name(),
decimals() on ETH, Base, Arb, Plasma, Mantle, Avalanche. Printed
anything non-zero.

Addresses labeled "nothing found on any chain" are either:
- on a chain we didn't try (Sui, Solana, BSC, Avalanche for some),
- empty EOAs,
- side contracts (oracles, redemption logic) with no token state,
- Sui object IDs that were accidentally pulled as EVM (adapter bug in my regex).

Full raw output: `/tmp/missing-report.txt` at scan time.
