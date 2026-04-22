#!/usr/bin/env node
/**
 * Euler v2 Scanner
 *
 * Uses Euler indexer for vault registry and Alchemy token balances for wallet holdings.
 * This avoids unreliable per-account subgraph reads and creates one position per held vault.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { fetchJSON } = require('./fetch-helper');
const { loadActiveWalletChains, loadWhaleWalletMap } = require('./recon-helpers');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;

const EULER_CHAINS = {
  eth: { chainId: 1, alchemy: 'https://eth-mainnet.g.alchemy.com/v2/' },
  base: { chainId: 8453, alchemy: 'https://base-mainnet.g.alchemy.com/v2/' },
  arb: { chainId: 42161, alchemy: 'https://arb-mainnet.g.alchemy.com/v2/' },
  sonic: { chainId: 146, alchemy: 'https://sonic-mainnet.g.alchemy.com/v2/' },
  op: { chainId: 10, alchemy: 'https://opt-mainnet.g.alchemy.com/v2/' },
  // Enable these once the Alchemy app has them turned on.
  monad: { chainId: 143, alchemy: 'https://monad-mainnet.g.alchemy.com/v2/' },
  bera: { chainId: 80085, alchemy: 'https://berachain-mainnet.g.alchemy.com/v2/' },
};

// Pace Alchemy RPC calls to avoid 429s. ~200ms/call = 5 req/s sustained.
let _lastRpcAt = 0;
async function _rpcThrottle() {
  const gap = 200;
  const wait = gap - (Date.now() - _lastRpcAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRpcAt = Date.now();
}

async function alchemy(method, params, chain) {
  const cfg = EULER_CHAINS[chain];
  if (!cfg?.alchemy || !ALCHEMY_KEY) return null;
  await _rpcThrottle();
  const res = await fetchJSON(`${cfg.alchemy}${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 3);
  return res?.result;
}

async function getBalances(wallet, chain) {
  const result = await alchemy('alchemy_getTokenBalances', [wallet], chain);
  return result?.tokenBalances || [];
}

// DeFiLlama chain slug for price lookups
const DL_CHAIN = {
  eth: 'ethereum', base: 'base', arb: 'arbitrum', sonic: 'sonic',
  op: 'optimism', monad: 'monad', bera: 'berachain',
};

async function getDefiLlamaPrice(chain, address) {
  try {
    const dlChain = DL_CHAIN[chain] || chain;
    const url = `https://coins.llama.fi/prices/current/${dlChain}:${address.toLowerCase()}`;
    const data = await fetchJSON(url, {}, 2);
    const key = `${dlChain}:${address.toLowerCase()}`;
    return data?.coins?.[key]?.price || null;
  } catch (e) {
    return null;
  }
}

// ERC-4626 convertToAssets(shares) — returns underlying asset amount
async function convertToAssets(chain, vaultAddress, sharesHex) {
  const selector = '0x07a2d13a'; // convertToAssets(uint256)
  // sharesHex is "0x..." — strip 0x, pad left to 64 chars
  const shares = sharesHex.replace(/^0x/, '').padStart(64, '0');
  const data = selector + shares;
  const result = await alchemy('eth_call', [{ to: vaultAddress, data }, 'latest'], chain);
  if (!result || result === '0x') return null;
  try { return BigInt(result); } catch (e) { return null; }
}

/**
 * Compute USD value of an Euler vault balance.
 * Flow: shares → convertToAssets() → underlying amount → × price → USD
 */
async function computeVaultValue(chain, vault, sharesHex, vaultDecimals, underlyingDecimals) {
  const underlyingRaw = await convertToAssets(chain, vault.vault, sharesHex);
  if (!underlyingRaw) return { value_usd: 0, method: 'convert-failed', amount: 0 };

  const uDec = underlyingDecimals ?? vaultDecimals ?? 18;
  const underlyingAmount = Number(underlyingRaw) / Math.pow(10, uDec);
  if (!vault.asset) return { value_usd: 0, method: 'no-asset', amount: underlyingAmount };

  const price = await getDefiLlamaPrice(chain, vault.asset);
  if (price == null) return { value_usd: 0, method: 'no-price', amount: underlyingAmount };

  return { value_usd: underlyingAmount * price, method: 'erc4626', amount: underlyingAmount, price };
}

// Cached underlying decimals (one call per unique asset)
const _decimalsCache = new Map();
async function getDecimals(chain, address) {
  const key = `${chain}:${address.toLowerCase()}`;
  if (_decimalsCache.has(key)) return _decimalsCache.get(key);
  const meta = await alchemy('alchemy_getTokenMetadata', [address], chain);
  const decimals = meta?.decimals ?? 18;
  _decimalsCache.set(key, decimals);
  return decimals;
}

async function fetchEulerVaults() {
  const byChain = {};

  for (const [chain, cfg] of Object.entries(EULER_CHAINS)) {
    try {
      // Indexer caps each page at 50 items, uses `page` for pagination
      // (NOT `skip`). Paginate until we've pulled all vaults or hit a hard cap.
      const map = {};
      const MAX_PAGES = 30; // 30 × 50 = 1500 vaults per chain (plenty)
      let total = 0;
      let totalKnown = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await fetchJSON(`https://indexer.euler.finance/v2/vault/list?chainId=${cfg.chainId}&page=${page}`, {}, 2);
        const items = data?.items || [];
        if (!items.length) break;
        for (const v of items) {
          const vault = String(v.vault || '').toLowerCase();
          if (!vault) continue;
          map[vault] = {
            vault,
            symbol: v.vaultSymbol || v.assetSymbol || `e${vault.slice(2, 8)}`,
            asset: String(v.asset || '').toLowerCase(),
            assetSymbol: v.assetSymbol || 'Unknown',
            decimals: v.vaultDecimals || 18,
            assetDecimals: v.assetDecimals || null,
            supplyApy: typeof v.supplyApy === 'number' ? v.supplyApy * 100 : null,
          };
        }
        total += items.length;
        totalKnown = data?.pagination?.total ?? totalKnown;
        if (totalKnown != null && total >= totalKnown) break;
        if (items.length < 50) break; // last page
      }
      byChain[chain] = map;
      console.log(`  Euler ${chain}: ${Object.keys(map).length} vaults${totalKnown != null ? ` (of ${totalKnown})` : ''}`);
    } catch (e) {
      byChain[chain] = null;
      console.log(`  Euler ${chain}: ${e.message}`);
    }
  }

  return byChain;
}

function upsertVaultPosition(db, wallet, chain, vault, valueInfo) {
  const walletLc = wallet.toLowerCase();
  const valueUsd = Number(valueInfo?.value_usd || 0);
  const underlyingAmount = Number(valueInfo?.amount || 0);
  const underlyingPrice = valueInfo?.price != null ? Number(valueInfo.price) : null;

  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE lower(wallet) = ? AND chain = ? AND protocol_name = 'Euler' AND position_index = ?
  `).get(walletLc, chain, vault.vault);

  let positionId;
  if (existing) {
    positionId = existing.id;
    db.prepare('DELETE FROM position_markets WHERE position_id = ?').run(positionId);
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(positionId);
    db.prepare(`
      UPDATE positions
      SET protocol_id = 'euler2', position_type = 'Lending', strategy = 'lend',
          net_usd = ?, asset_usd = ?, debt_usd = 0, scanned_at = datetime('now')
      WHERE id = ?
    `).run(valueUsd, valueUsd, positionId);
  } else {
    const result = db.prepare(`
      INSERT INTO positions (
        wallet, chain, protocol_id, protocol_name, position_type, strategy,
        net_usd, asset_usd, debt_usd, position_index, scanned_at
      ) VALUES (?, ?, 'euler2', 'Euler', 'Lending', 'lend', ?, ?, 0, ?, datetime('now'))
    `).run(walletLc, chain, valueUsd, valueUsd, vault.vault);
    positionId = result.lastInsertRowid;
  }

  const apyBase = valueInfo?.apy_base != null ? Number(valueInfo.apy_base) : 0;
  db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
    VALUES (?, 'supply', ?, ?, ?, ?, ?, ?)
  `).run(positionId, vault.symbol, vault.asset || vault.vault, underlyingAmount, underlyingPrice, valueUsd, apyBase);
}

function cleanupWallet(db, wallet, scannedChains, seenKeys) {
  const walletLc = wallet.toLowerCase();
  const existing = db.prepare(`
    SELECT id, chain, position_index FROM positions
    WHERE lower(wallet) = ? AND protocol_name = 'Euler'
  `).all(walletLc);

  for (const row of existing) {
    if (!scannedChains.has(row.chain)) continue;
    const key = `${row.chain}:${String(row.position_index || '').toLowerCase()}`;
    if (!row.position_index || !seenKeys.has(key)) {
      db.prepare('DELETE FROM position_markets WHERE position_id = ?').run(row.id);
      db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(row.id);
      db.prepare('DELETE FROM positions WHERE id = ?').run(row.id);
    }
  }
}

async function scanWallet(db, wallet, label, vaultsByChain) {
  console.log(`\n--- ${label} (${wallet.slice(0, 12)}) ---`);
  const seenKeys = new Set();
  const scannedChains = new Set();
  let count = 0;

  for (const [chain, vaultMap] of Object.entries(vaultsByChain)) {
    if (!vaultMap) continue;

    const balances = await getBalances(wallet, chain);
    scannedChains.add(chain);
    if (!balances.length) continue;

    for (const bal of balances) {
      const amountHex = bal.tokenBalance;
      // Robust zero-balance check — Alchemy returns padded zeros like 0x000...000
      if (!amountHex || amountHex === '0x' || /^0x0+$/.test(amountHex)) continue;
      const addr = String(bal.contractAddress || '').toLowerCase();
      const vault = vaultMap[addr];
      if (!vault) continue;

      // ERC-4626: convert shares → underlying → USD
      // Use indexer-provided decimals when available, else fetch via RPC.
      const underlyingDecimals = vault.assetDecimals
        ?? (vault.asset ? await getDecimals(chain, vault.asset) : vault.decimals || 18);
      const valueInfo = await computeVaultValue(chain, vault, amountHex, vault.decimals, underlyingDecimals);
      // Attach supply APY from indexer if we have it
      if (vault.supplyApy != null) valueInfo.apy_base = vault.supplyApy;

      upsertVaultPosition(db, wallet, chain, vault, valueInfo);
      seenKeys.add(`${chain}:${vault.vault}`);
      count++;
      const usdStr = valueInfo.value_usd > 0 ? `$${(valueInfo.value_usd / 1e6).toFixed(2)}M` : `[${valueInfo.method}]`;
      const apyStr = vault.supplyApy != null ? ` APY ${vault.supplyApy.toFixed(2)}%` : '';
      console.log(`  ${chain} ${vault.symbol.padEnd(20)} (${vault.assetSymbol}) ${usdStr}${apyStr}`);
    }
  }

  cleanupWallet(db, wallet, scannedChains, seenKeys);

  if (count === 0) console.log('  No Euler positions');
  else console.log(`  Created/updated ${count} Euler vault positions`);
  return count;
}

async function main() {
  const db = new Database(DB_PATH);
  let walletMap = [];
  const active = loadActiveWalletChains();
  if (active && active.length > 0) {
    const labelByWallet = new Map(loadWhaleWalletMap().map(w => [w.addr, w.label]));
    const seen = new Set();
    for (const row of active) {
      if (seen.has(row.wallet)) continue;
      seen.add(row.wallet);
      walletMap.push({ addr: row.wallet, label: labelByWallet.get(row.wallet) || row.whale || 'Unknown' });
    }
  } else {
    const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
    for (const [name, config] of Object.entries(whales)) {
      const wallets = Array.isArray(config)
        ? config
        : (config.vaults ? Object.values(config.vaults).flat() : []);
      for (const w of wallets) walletMap.push({ addr: w.toLowerCase(), label: name });
    }
  }

  console.log('=== Euler v2 Scanner ===');
  console.log('Loading Euler vault registry...');
  const vaultsByChain = await fetchEulerVaults();
  console.log(`Scanning ${walletMap.length} wallets`);

  let totalFound = 0;
  for (const w of walletMap) {
    const found = await scanWallet(db, w.addr, w.label, vaultsByChain);
    totalFound += found;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n=== Done: ${totalFound} vault positions ===`);
  db.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
