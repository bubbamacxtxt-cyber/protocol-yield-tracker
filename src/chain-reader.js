#!/usr/bin/env node
/**
 * chain-reader.js
 * On-chain position discovery via JSON-RPC.
 * Reads vault shares for Morpho v1/v2, Euler, and other ERC-4626 vaults.
 *
 * KEY FINDING: Morpho v2 vaults (VaultV2 contracts) are NOT indexed by
 * Morpho's GraphQL API. Must be discovered on-chain or via Etherscan.
 * Example: senRLUSDv2 = 0x6dC58a0FdfC8D694e571DC59B9A52EEEa780E6bf
 *
 * Run: node src/chain-reader.js
 */

const RPC_URL = 'https://eth.drpc.org'; // More reliable than llamarpc

// ─── Known Vault Addresses ──────────────────────────────────
// Morpho v1 vaults (indexed by Morpho API)
const MORPHO_V1_VAULTS = [
  { addr: '0x36716540fcAB3eE593651Ea4A00A48c85D6Fd74C', symbol: 'senPYUSD', asset: 'PYUSD' },
  { addr: '0x71cb2F8038B2C5D65ddc740B2F3268890CD2A89C', symbol: 'senRLUSD', asset: 'RLUSD' },
  { addr: '0x2C793f5cB25B35A99648783c01E6cCCC200D2096', symbol: 'senPYUSDcore', asset: 'PYUSD' },
  { addr: '0xbEEF02e5E13584ab96848af90261f0C8Ee04722a', symbol: 'steakPYUSD', asset: 'PYUSD' },
];

// Morpho v2 vaults (VaultV2 contracts — NOT indexed by Morpho API!)
const MORPHO_V2_VAULTS = [
  { addr: '0x6dC58a0FdfC8D694e571DC59B9A52EEEa780E6bf', symbol: 'senRLUSDv2', asset: 'RLUSD' },
  // TODO: Find senPYUSDv2 address (not indexed by Morpho API)
];

// ERC-20 selectors
const BALANCE_OF = '0x70a08231';
const DECIMALS   = '0x313ce567';
const SYMBOL     = '0x95d89b41';
const TOTAL_SUPPLY = '0x18160ddd';

// ERC-4626 selectors
const TOTAL_ASSETS = '0x01e1d114';
const ASSET        = '0x52ef1b7d'; // asset() — returns underlying token address

// ─── Helpers ────────────────────────────────────────────────

function encodeAddress(addr) {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

function decodeString(hex) {
  if (!hex || hex === '0x') return '';
  try {
    const h = hex.replace('0x', '');
    const offset = parseInt(h.slice(0, 64), 16) * 2;
    const length = parseInt(h.slice(offset, offset + 64), 16);
    return Buffer.from(h.slice(offset + 64, offset + 64 + length * 2), 'hex').toString('utf8');
  } catch { return ''; }
}

async function ethCall(to, data) {
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
    });
    const json = await res.json();
    if (json.error || !json.result || json.result === '0x') return null;
    return json.result;
  } catch { return null; }
}

async function getBalance(contractAddr, walletAddr) {
  const data = BALANCE_OF + encodeAddress(walletAddr);
  const result = await ethCall(contractAddr, data);
  return result ? BigInt(result) : 0n;
}

async function getDecimals(contractAddr) {
  const result = await ethCall(contractAddr, DECIMALS);
  return result ? Number(BigInt(result)) : 18;
}

async function getSymbol(contractAddr) {
  const result = await ethCall(contractAddr, SYMBOL);
  return decodeString(result) || 'UNKNOWN';
}

async function getTotalAssets(contractAddr) {
  const result = await ethCall(contractAddr, TOTAL_ASSETS);
  return result ? BigInt(result) : 0n;
}

async function getAsset(contractAddr) {
  const result = await ethCall(contractAddr, ASSET);
  return result ? '0x' + result.slice(-40) : null;
}

// ─── Vault Scanner ──────────────────────────────────────────

async function scanVault(wallet, vault, label) {
  const shares = await getBalance(vault.addr, wallet);
  if (shares === 0n) return null;

  const dec = await getDecimals(vault.addr);
  const assets = await getTotalAssets(vault.addr);
  const supply = await getBalance(vault.addr, vault.addr); // totalSupply via balanceOf self

  const sharesFormatted = Number(shares) / 10 ** dec;
  const assetsFormatted = Number(assets) / 10 ** dec;

  return {
    vault: vault.addr,
    symbol: vault.symbol || label,
    asset: vault.asset,
    shares: sharesFormatted,
    totalAssets: assetsFormatted,
    sharePercent: supply > 0n ? (Number(shares) / Number(supply) * 100).toFixed(2) : '0',
    source: label
  };
}

async function scanAllVaults(wallet) {
  const allVaults = [
    ...MORPHO_V1_VAULTS.map(v => ({ ...v, source: 'morpho-v1' })),
    ...MORPHO_V2_VAULTS.map(v => ({ ...v, source: 'morpho-v2' })),
  ];

  console.log(`\nScanning ${allVaults.length} vaults for ${wallet.slice(0,12)}...`);
  const found = [];

  for (const vault of allVaults) {
    const result = await scanVault(wallet, vault, vault.source);
    if (result) {
      found.push(result);
      console.log(`  ✅ ${result.symbol} (${result.asset}): ${result.shares.toFixed(2)} shares (~$${result.shares.toFixed(0)}) ${result.sharePercent}% of vault`);
    }
    await new Promise(r => setTimeout(r, 100)); // Rate limit
  }

  return found;
}

// ─── Euler Scanner (from indexer) ───────────────────────────

async function scanEuler(wallet) {
  try {
    const res = await fetch('https://indexer.euler.finance/v2/vault/list?chainId=1&take=200');
    if (!res.ok) return [];
    const data = await res.json();
    const vaults = data.items || [];
    const found = [];

    for (const v of vaults) {
      const shares = await getBalance(v.vault, wallet);
      if (shares > 0n) {
        const dec = v.vaultDecimals || 18;
        const sharesFormatted = Number(shares) / 10 ** dec;
        found.push({
          vault: v.vault,
          symbol: v.vaultSymbol,
          asset: v.assetSymbol,
          shares: sharesFormatted,
          supplyApy: v.supplyApy?.baseApy,
          rewardApy: v.supplyApy?.rewardApy,
          totalApy: v.supplyApy?.totalApy,
          tvl: v.totalAssetsUSD,
          source: 'euler-indexer'
        });
        console.log(`  ✅ ${v.vaultSymbol} (${v.assetSymbol}): ${sharesFormatted.toFixed(4)} vault tokens APY=${v.supplyApy?.baseApy?.toFixed(2)}%+${v.supplyApy?.rewardApy?.toFixed(2)}%`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return found;
  } catch (e) {
    console.log('  ❌ Euler scan failed:', e.message);
    return [];
  }
}

// ─── Discover New Vaults (unlisted) ─────────────────────────
// Check a vault address for any balance - useful for discovering
// v2 vaults that aren't in the known list

async function probeVault(vaultAddr, wallets, label) {
  console.log(`  Probing ${label} (${vaultAddr.slice(0,12)}...)...`);
  let foundAny = false;
  for (const w of wallets) {
    const bal = await getBalance(vaultAddr, w);
    if (bal > 0n) {
      const dec = await getDecimals(vaultAddr);
      const sym = await getSymbol(vaultAddr);
      console.log(`    ✅ ${w.slice(0,12)} has ${(Number(bal) / 10**dec).toFixed(2)} ${sym} shares`);
      foundAny = true;
    }
  }
  return foundAny;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const wallets = [
    { label: 'Reservoir', addr: '0x3063c5907faa10c01b242181aa689beb23d2bd65' },
    { label: 'Reservoir-2', addr: '0x289c204b35859bfb924b9c0759a4fe80f610671c' },
    { label: 'Makina', addr: '0xd1a1c248b253f1fc60eacd90777b9a63f8c8c1bc' },
  ];

  console.log('=== On-Chain Position Discovery ===');
  console.log('RPC: ' + RPC_URL);
  console.log('Time: ' + new Date().toISOString());

  for (const w of wallets) {
    console.log(`\n--- ${w.label} (${w.addr}) ---`);

    const morpho = await scanAllVaults(w.addr);
    const euler = await scanEuler(w.addr);

    const total = morpho.length + euler.length;
    console.log(`\n  TOTAL: ${total} positions (${morpho.length} Morpho + ${euler.length} Euler)`);

    // Output JSON for pipeline use
    if (total > 0) {
      const output = { wallet: w.addr, label: w.label, morpho, euler, timestamp: new Date().toISOString() };
      console.log('\nJSON:', JSON.stringify(output));
    }
  }

  // Discovery mode: probe unknown vault addresses
  console.log('\n--- Vault Discovery ---');
  console.log('To discover new vaults, add address and run:');
  console.log('  probeVault("0xNEW_ADDRESS", wallets, "Label")');
}

main().catch(console.error);
