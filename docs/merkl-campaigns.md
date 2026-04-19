# Merkl Campaign Rules - USDe/sUSDe on Aave

**Last updated:** 2026-04-19
**⚠️ These are campaign-specific and can change. Always check Merkl API for current campaigns.**

## Campaign: "Lend sUSDe and USDe on Aave (looping required)"

- **APR:** 3.75% (eth), 3.60% (plasma), 3.75% (mnt)
- **Protocol:** Aave V3
- **Eligible tokens:** sUSDe, USDe

### Rules:
1. **Wallet MUST supply BOTH sUSDe AND USDe** on the same Aave market/chain
2. **Bonus applies to USDe ONLY** (not sUSDe) - sUSDe is a requirement, not rewarded
3. **Must borrow USDC or USDT** (looping requirement)
4. **Health Factor must be < 2.5** (leverage requirement)
5. **Campaign type:** "lowest amount of tokens lent across sUSDe and USDe" - determines which gets bonus when both present (always USDe)

### Implementation notes (fetch-merkl.js):
- `minOfTokens` field parsed from campaign description containing "lowest ... X and Y"
- Token matching excludes sUSDe (`posSymbol === 'SUSDE' → return false`)
- Wallet matching requires all minOfTokens to be present (`!rules.minOfTokens.every(t => walletSupplies.includes(t)) → return false`)

### Affected wallets:
- **Yuzu (0x502d222e):** Has both sUSDe + USDe → qualifies ✓
- **Avant wallets:** Only USDe, no sUSDe → no bonus ✗

---
*This campaign is part of Ethena's liquid leverage program via Merkl. Check https://app.merkl.xyz for current campaigns.*
