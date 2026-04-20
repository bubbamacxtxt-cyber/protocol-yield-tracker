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

async function alchemy(method, params, chain) {
  const cfg = EULER_CHAINS[chain];
  if (!cfg?.alchemy || !ALCHEMY_KEY) return null;
  const res = await fetchJSON(`${cfg.alchemy}${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 1);
  return res?.result;
}

async function getBalances(wallet, chain) {
  const result = await alchemy('alchemy_getTokenBalances', [wallet], chain);
  return result?.tokenBalances || [];
}

async function fetchEulerVaults() {
  const byChain = {};

  for (const [chain, cfg] of Object.entries(EULER_CHAINS)) {
    try {
      const data = await fetchJSON(`https://indexer.euler.finance/v2/vault/list?chainId=${cfg.chainId}&take=1000`, {}, 2);
      const items = data?.items || [];
      const map = {};
      for (const v of items) {
        const vault = String(v.vault || '').toLowerCase();
        if (!vault) continue;
        map[vault] = {
          vault,
          symbol: v.vaultSymbol || v.assetSymbol || `e${vault.slice(2, 8)}`,
          asset: String(v.asset || '').toLowerCase(),
          assetSymbol: v.assetSymbol || 'Unknown',
          decimals: v.vaultDecimals || 18,
        };
      }
      byChain[chain] = map;
      console.log(`  Euler ${chain}: ${items.length} vaults`);
    } catch (e) {
      byChain[chain] = null;
      console.log(`  Euler ${chain}: ${e.message}`);
    }
  }

  return byChain;
}

function upsertVaultPosition(db, wallet, chain, vault) {
  const walletLc = wallet.toLowerCase();
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
          net_usd = 0, asset_usd = 0, debt_usd = 0, scanned_at = datetime('now')
      WHERE id = ?
    `).run(positionId);
  } else {
    const result = db.prepare(`
      INSERT INTO positions (
        wallet, chain, protocol_id, protocol_name, position_type, strategy,
        net_usd, asset_usd, debt_usd, position_index, scanned_at
      ) VALUES (?, ?, 'euler2', 'Euler', 'Lending', 'lend', 0, 0, 0, ?, datetime('now'))
    `).run(walletLc, chain, vault.vault);
    positionId = result.lastInsertRowid;
  }

  db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, value_usd, apy_base)
    VALUES (?, 'supply', ?, ?, 0, 0)
  `).run(positionId, vault.symbol, vault.asset || vault.vault);
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
      if (!amountHex || amountHex === '0x0' || amountHex === '0x00') continue;
      const addr = String(bal.contractAddress || '').toLowerCase();
      const vault = vaultMap[addr];
      if (!vault) continue;

      upsertVaultPosition(db, wallet, chain, vault);
      seenKeys.add(`${chain}:${vault.vault}`);
      count++;
      console.log(`  ${chain} ${vault.symbol} (${vault.assetSymbol})`);
    }
  }

  cleanupWallet(db, wallet, scannedChains, seenKeys);

  if (count === 0) console.log('  No Euler positions');
  else console.log(`  Created/updated ${count} Euler vault positions`);
  return count;
}

async function main() {
  const db = new Database(DB_PATH);
  const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
  const walletMap = [];

  for (const [name, config] of Object.entries(whales)) {
    const wallets = Array.isArray(config)
      ? config
      : (config.vaults ? Object.values(config.vaults).flat() : []);
    for (const w of wallets) walletMap.push({ addr: w.toLowerCase(), label: name });
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
