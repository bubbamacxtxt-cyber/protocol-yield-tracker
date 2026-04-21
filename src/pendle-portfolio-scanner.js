#!/usr/bin/env node
/**
 * Pendle Portfolio Scanner
 *
 * Uses Pendle's portfolio endpoint to discover open PT/YT/LP positions per wallet.
 * Endpoint: GET /v1/dashboard/positions/database/{user}
 *
 * This replaces the need for DeBank fallback for Pendle and provides structured
 * open positions with valuations, balances, and market IDs.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const PENDLE_API_BASE = 'https://api-v2.pendle.finance/core';

// Chains to scan
const CHAINS = [
  { name: 'eth', chainId: 1 },
  { name: 'arb', chainId: 42161 },
  { name: 'base', chainId: 8453 },
  { name: 'plasma', chainId: 9745 },
];

// Map chainId to Pendle chain prefix used in marketId
function chainIdToPrefix(chainId) {
  if (chainId === 1) return '1';
  if (chainId === 42161) return '42161';
  if (chainId === 8453) return '8453';
  if (chainId === 9745) return '9745';
  return String(chainId);
}

async function fetchWithRetry(url, retries = 3, baseDelay = 1000) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url);
    if (res.status === 429) {
      const delay = baseDelay * Math.pow(2, i);
      console.log(`  Rate limited, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    if (!res.ok) return null;
    return res.json();
  }
  return null;
}

async function fetchPositionsForWallet(address) {
  const user = address.toLowerCase();
  const url = `${PENDLE_API_BASE}/v1/dashboard/positions/database/${user}`;
  return fetchWithRetry(url);
}

function daysToExpiryFromMarketId(marketId) {
  // marketId format: {chainId}-{marketAddress}
  // We don't have expiry from this endpoint directly, but we can infer from market metadata later.
  // For now, return null; expiry enrichment can happen in a separate pass.
  return null;
}

function makePosition(userAddress, chainName, chainId, marketId, role, balanceRaw, valuationUsd) {
  if (!balanceRaw || balanceRaw === '0') return null;
  const balanceNum = Number(balanceRaw);
  if (!balanceNum || balanceNum <= 0) return null;
  
  const valueUsd = typeof valuationUsd === 'number' ? valuationUsd : 0;
  
  // For now, treat raw balance as direct amount (the API may return human-readable or wei)
  // We'll normalize based on valuation consistency
  const amount = balanceNum;
  const priceUsd = valueUsd > 0 && amount > 0 ? valueUsd / amount : 0;
  
  return {
    wallet: userAddress,
    chain: chainName,
    chainId,
    protocol_id: `pendle-${role}`,
    protocol_name: 'Pendle',
    position_type: 'supply',
    strategy: `pendle-${role}`,
    yield_source: 'pendle',
    position_index: `${marketId}:${role}`,
    token_address: '',
    symbol: `${role.toUpperCase()}-${marketId}`,
    amount,
    price_usd: priceUsd,
    value_usd: valueUsd,
    net_usd: valueUsd,
    asset_usd: valueUsd,
    apy_base: null,
    expiry: null,
    days_to_expiry: null,
  };
}

function normalizePendleRole(role) {
  if (role === 'pt') return 'pt';
  if (role === 'yt') return 'yt';
  if (role === 'lp') return 'lp';
  return null;
}

async function scanWallet(db, address, label) {
  console.log(`\n--- ${label} (${address.slice(0, 12)}) ---`);
  
  // Respect rate limits: add small delay before each call
  await new Promise(r => setTimeout(r, 250));
  
  const data = await fetchPositionsForWallet(address);
  if (!data || !data.positions || !data.positions.length) {
    console.log('  No Pendle portfolio data');
    return [];
  }
  
  const found = [];
  
  for (const chainPos of data.positions) {
    const chainId = chainPos.chainId;
    const chainName = CHAINS.find(c => c.chainId === chainId)?.name || `chain-${chainId}`;
    
    for (const marketPos of chainPos.openPositions || []) {
      const marketId = marketPos.marketId;
      
      // PT position
      if (marketPos.pt && marketPos.pt.balance && marketPos.pt.balance !== '0') {
        const pos = makePosition(address, chainName, chainId, marketId, 'pt', marketPos.pt.balance, marketPos.pt.valuation || 0);
        if (pos) { found.push(pos); console.log(`  ${chainName} PT ${pos.symbol} $${pos.value_usd.toFixed(2)}`); }
      }
      
      // YT position
      if (marketPos.yt && marketPos.yt.balance && marketPos.yt.balance !== '0') {
        const pos = makePosition(address, chainName, chainId, marketId, 'yt', marketPos.yt.balance, marketPos.yt.valuation || 0);
        if (pos) { found.push(pos); console.log(`  ${chainName} YT ${pos.symbol} $${pos.value_usd.toFixed(2)}`); }
      }
      
      // LP position
      if (marketPos.lp && marketPos.lp.balance && marketPos.lp.balance !== '0') {
        const pos = makePosition(address, chainName, chainId, marketId, 'lp', marketPos.lp.balance, marketPos.lp.valuation || 0);
        if (pos) { found.push(pos); console.log(`  ${chainName} LP ${pos.symbol} $${pos.value_usd.toFixed(2)}`); }
      }
    }
  }
  
  // Upsert into DB
  if (found.length > 0) {
    const tx = db.transaction(() => {
      for (const pos of found) {
        upsertPosition(db, pos);
      }
    });
    tx();
  }
  
  if (!found.length) console.log('  No Pendle positions');
  return found;
}

function upsertPosition(db, pos) {
  const walletLc = pos.wallet.toLowerCase();
  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE lower(wallet) = ? AND chain = ? AND protocol_id = ? AND position_index = ?
  `).get(walletLc, pos.chain, pos.protocol_id, pos.position_index);

  let positionId;
  if (existing) {
    positionId = existing.id;
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(positionId);
    db.prepare(`
      UPDATE positions
      SET protocol_name = ?, position_type = ?, strategy = ?, yield_source = ?,
          net_usd = ?, asset_usd = ?, debt_usd = 0, scanned_at = datetime('now')
      WHERE id = ?
    `).run(pos.protocol_name, pos.position_type, pos.strategy, pos.yield_source, pos.net_usd, pos.asset_usd, positionId);
  } else {
    const result = db.prepare(`
      INSERT INTO positions (
        wallet, chain, protocol_id, protocol_name, position_type, strategy, yield_source,
        net_usd, asset_usd, debt_usd, position_index, scanned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
    `).run(walletLc, pos.chain, pos.protocol_id, pos.protocol_name, pos.position_type, pos.strategy, pos.yield_source, pos.net_usd, pos.asset_usd, pos.position_index);
    positionId = result.lastInsertRowid;
  }

  db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base, apy_base_source)
    VALUES (?, 'supply', ?, ?, ?, ?, ?, ?, 'pendle-portfolio')
  `).run(positionId, pos.symbol, pos.token_address || pos.position_index, pos.amount, pos.price_usd, pos.value_usd, pos.apy_base);
}

async function main() {
  const db = new Database(DB_PATH);

  // Load wallet list
  const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
  const walletMap = [];

  for (const [name, config] of Object.entries(whales)) {
    const wallets = Array.isArray(config)
      ? config
      : (config.vaults ? Object.values(config.vaults).flat() : []);
    for (const w of wallets) walletMap.push({ addr: w.toLowerCase(), label: name });
  }

  console.log('=== Pendle Portfolio Scanner ===');
  console.log(`Scanning ${walletMap.length} wallets`);

  let total = 0;
  for (const w of walletMap) {
    const found = await scanWallet(db, w.addr, w.label);
    total += found.length;
  }

  console.log(`\n=== Done: ${total} Pendle positions ===`);
  db.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { fetchPositionsForWallet, scanWallet };
