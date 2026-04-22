#!/usr/bin/env node
/**
 * Ethena Scanner
 *
 * Detects Ethena-issued positions that are NOT covered by Layer 2 token
 * discovery (YBS sUSDe / wallet-held USDe).
 *
 * The one thing we miss: "Locked USDe" during the 7-day cooldown.
 * When a holder calls `cooldownShares(shares)` on sUSDe, their sUSDe
 * shares are burned and the underlying USDe is locked in the sUSDe
 * contract for 7 days. During that window the wallet holds NO sUSDe
 * and NO USDe \u2014 the funds are invisible to balanceOf-based scanners.
 *
 * Detection: read `cooldowns(address)` on the sUSDe contract.
 * Returns struct { uint104 cooldownEnd, uint152 underlyingAmount }.
 *
 * Per docs/TOKEN-RULES.md: Ethena is a protocol scanner. APY comes from
 * the YBS list (stables.json \u2014 sUSDe). Locked USDe earns NO yield during
 * cooldown, so we set apy = 0.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { ethers } = require('ethers');
const { fetchJSON } = require('./fetch-helper');
const { loadActiveWalletChains, loadWhaleWalletMap } = require('./recon-helpers');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;

// sUSDe is on ETH only (bridged copies are just locked tokens without staking)
const SUSDE_ETH = '0x9d39a5de30e57443bff2a8307a4256c8797a3497';
const USDE_ETH = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3';
const ETH_RPC = () => `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

// cooldowns(address) \u2192 (uint104 cooldownEnd, uint152 underlyingAmount)
const SEL_COOLDOWNS = '0x01320fe2';

let _lastRpcAt = 0;
async function _rpcThrottle() {
  const wait = 150 - (Date.now() - _lastRpcAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRpcAt = Date.now();
}

async function ethCall(to, data) {
  await _rpcThrottle();
  const res = await fetchJSON(ETH_RPC(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  }, 2);
  const result = res?.result;
  return (result && result !== '0x') ? result : null;
}

async function getDefiLlamaPrice(address) {
  try {
    const url = `https://coins.llama.fi/prices/current/ethereum:${address.toLowerCase()}`;
    const data = await fetchJSON(url, {}, 2);
    const key = `ethereum:${address.toLowerCase()}`;
    return data?.coins?.[key]?.price || null;
  } catch { return null; }
}

async function getCooldown(wallet) {
  const padded = wallet.replace(/^0x/, '').padStart(64, '0').toLowerCase();
  const result = await ethCall(SUSDE_ETH, SEL_COOLDOWNS + padded);
  if (!result) return null;
  // Two uint256 slots packed
  const hex = result.replace(/^0x/, '');
  if (hex.length < 128) return null;
  const cooldownEnd = Number(BigInt('0x' + hex.slice(0, 64)));
  const underlyingRaw = BigInt('0x' + hex.slice(64, 128));
  if (underlyingRaw === 0n) return null;
  return {
    cooldownEnd,
    underlyingAmount: Number(underlyingRaw) / 1e18,
  };
}

function upsertLockedPosition(db, wallet, cooldown, price) {
  const valueUsd = cooldown.underlyingAmount * (price || 1);
  const positionIndex = `ethena-cooldown:${SUSDE_ETH}`;

  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE lower(wallet) = ? AND chain = 'eth' AND protocol_id = 'ethena-cooldown' AND position_index = ?
  `).get(wallet.toLowerCase(), positionIndex);

  let positionId;
  if (existing) {
    positionId = existing.id;
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(positionId);
    db.prepare(`
      UPDATE positions
      SET protocol_id = 'ethena-cooldown', protocol_name = 'Ethena',
          position_type = 'Locked', strategy = 'cooldown', yield_source = ?,
          net_usd = ?, asset_usd = ?, debt_usd = 0, scanned_at = datetime('now')
      WHERE id = ?
    `).run(`cooldown:${new Date(cooldown.cooldownEnd * 1000).toISOString()}`, valueUsd, valueUsd, positionId);
  } else {
    const result = db.prepare(`
      INSERT INTO positions (
        wallet, chain, protocol_id, protocol_name, position_type, strategy,
        yield_source, net_usd, asset_usd, debt_usd, position_index, scanned_at
      ) VALUES (?, 'eth', 'ethena-cooldown', 'Ethena', 'Locked', 'cooldown', ?, ?, ?, 0, ?, datetime('now'))
    `).run(
      wallet.toLowerCase(),
      `cooldown:${new Date(cooldown.cooldownEnd * 1000).toISOString()}`,
      valueUsd, valueUsd, positionIndex
    );
    positionId = result.lastInsertRowid;
  }

  // Locked USDe during cooldown earns NO yield. APY is 0.
  db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
    VALUES (?, 'supply', 'USDe', ?, ?, ?, ?, 0)
  `).run(positionId, USDE_ETH, cooldown.underlyingAmount, price || 1, valueUsd);

  return positionId;
}

function cleanupClearedWallets(db, scannedWallets, walletsWithCooldown) {
  const scannedSet = new Set(scannedWallets.map(w => w.toLowerCase()));
  const withCooldown = new Set(walletsWithCooldown.map(w => w.toLowerCase()));

  // Delete ethena-cooldown rows for wallets we scanned but found no cooldown
  let removed = 0;
  const rows = db.prepare(`
    SELECT id, wallet FROM positions WHERE protocol_id = 'ethena-cooldown'
  `).all();
  for (const r of rows) {
    const lc = r.wallet.toLowerCase();
    if (scannedSet.has(lc) && !withCooldown.has(lc)) {
      db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(r.id);
      db.prepare('DELETE FROM positions WHERE id = ?').run(r.id);
      removed++;
    }
  }
  if (removed > 0) console.log(`Cleaned ${removed} expired ethena-cooldown rows`);
}

async function main() {
  if (!ALCHEMY_KEY) {
    console.error('Missing ALCHEMY_API_KEY');
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  // Important: scan EVERY tracked wallet, not just those active on eth in
  // the DeBank recon. Locked USDe is invisible to DeBank's chain_balance
  // endpoint — when funds are in cooldown the wallet's on-chain USDe/sUSDe
  // is zero, so DeBank reports the Ethereum chain as empty. This scanner
  // MUST run on every whale wallet to avoid that blind spot.
  let wallets = [];
  const whaleMap = loadWhaleWalletMap();
  for (const w of whaleMap) {
    wallets.push({ addr: w.addr.toLowerCase(), label: w.label });
  }
  if (wallets.length === 0) {
    // Fallback to whales.json
    const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
    for (const [name, config] of Object.entries(whales)) {
      const ws = Array.isArray(config) ? config : (config.vaults ? Object.values(config.vaults).flat() : []);
      for (const w of ws) wallets.push({ addr: w.toLowerCase(), label: name });
    }
  }

  console.log('=== Ethena Scanner ===');
  console.log(`Checking cooldowns for ${wallets.length} ETH-active wallets\n`);

  const price = await getDefiLlamaPrice(USDE_ETH);
  console.log(`USDe price: $${(price || 1).toFixed(4)}\n`);

  const walletsWithCooldown = [];
  let totalUsd = 0;

  for (const w of wallets) {
    try {
      const cd = await getCooldown(w.addr);
      if (!cd) continue;
      // Skip dust (cooldown may be set with tiny amount)
      if (cd.underlyingAmount * (price || 1) < 1000) continue;

      upsertLockedPosition(db, w.addr, cd, price);
      walletsWithCooldown.push(w.addr);
      const valueUsd = cd.underlyingAmount * (price || 1);
      totalUsd += valueUsd;
      const endDate = new Date(cd.cooldownEnd * 1000).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`  ${w.label} (${w.addr.slice(0, 12)}) $${(valueUsd / 1e6).toFixed(2)}M locked, unlocks ${endDate}`);
    } catch (e) {
      console.error(`  ${w.addr.slice(0, 12)} err:`, e.message);
    }
  }

  cleanupClearedWallets(db, wallets.map(w => w.addr), walletsWithCooldown);

  console.log(`\n=== Done ===`);
  console.log(`Locked USDe positions: ${walletsWithCooldown.length}`);
  console.log(`Total: $${(totalUsd / 1e6).toFixed(2)}M`);
  db.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { getCooldown };
