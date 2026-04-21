#!/usr/bin/env node
/**
 * Pendle v1 scanner
 *
 * Explicit V1 scope:
 * - authoritative direct PT holdings
 * - authoritative direct YT holdings
 * - optional direct LP token holdings when actually observed
 *
 * Non-goals for this scanner:
 * - decomposing bundled DeBank Pendle exposures
 * - inferring wrapped/gauge/vault LP exposure from protocol-level blobs
 * - destructive replacement of unresolved Pendle fallback rows
 *
 * Uses Pendle core API for registry/economics and direct balanceOf checks for token truth.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { fetchJSON } = require('./fetch-helper');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;

const PENDLE_CHAINS = {
  eth: { chainId: 1, alchemy: 'https://eth-mainnet.g.alchemy.com/v2/' },
  arb: { chainId: 42161, alchemy: 'https://arb-mainnet.g.alchemy.com/v2/' },
  base: { chainId: 8453, alchemy: 'https://base-mainnet.g.alchemy.com/v2/' },
  plasma: { chainId: 9745, alchemy: 'https://9745.rpc.thirdweb.com/' },
};

async function alchemy(method, params, chain) {
  const cfg = PENDLE_CHAINS[chain];
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

function uniq(arr) {
  return [...new Set(arr)];
}

async function fetchPendleMarketsByChain(chain, chainId) {
  const all = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const data = await fetchJSON(`https://api-v2.pendle.finance/core/v1/${chainId}/markets?is_expired=false&limit=${limit}&skip=${skip}`, {}, 2);
    const results = data?.results || [];
    if (!results.length) break;
    all.push(...results);
    if (results.length < limit) break;
    skip += limit;
  }

  console.log(`  Pendle ${chain}: ${all.length} active markets`);
  return all;
}

async function buildPendleRegistry() {
  const byChain = {};

  for (const [chain, cfg] of Object.entries(PENDLE_CHAINS)) {
    try {
      const markets = await fetchPendleMarketsByChain(chain, cfg.chainId);
      const pt = {};
      const yt = {};
      const lp = {};
      const direct = [];

      for (const m of markets) {
        const meta = {
          marketAddress: String(m.address || '').toLowerCase(),
          chain,
          chainId: cfg.chainId,
          expiry: m.expiry || null,
          pt: m.pt || null,
          yt: m.yt || null,
          sy: m.sy || null,
          underlying: m.underlyingAsset || null,
          details: m.details || {},
          symbol: m.symbol || 'PENDLE-LPT',
        };

        if (m.pt?.address) {
          const addr = String(m.pt.address).toLowerCase();
          pt[addr] = meta;
          direct.push({ type: 'pt', addr, meta });
        }
        if (m.yt?.address) {
          const addr = String(m.yt.address).toLowerCase();
          yt[addr] = meta;
          direct.push({ type: 'yt', addr, meta });
        }
        if (m.address) {
          const addr = String(m.address).toLowerCase();
          lp[addr] = meta;
          direct.push({ type: 'lp', addr, meta });
        }
      }

      byChain[chain] = { pt, yt, lp, direct };
    } catch (e) {
      console.log(`  Pendle ${chain}: ${e.message}`);
      byChain[chain] = null;
    }
  }

  return byChain;
}

function daysToExpiry(expiry) {
  if (!expiry) return null;
  const ms = new Date(expiry).getTime() - Date.now();
  return Math.max(0, ms / 86400000);
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
    VALUES (?, 'supply', ?, ?, ?, ?, ?, ?, 'pendle')
  `).run(positionId, pos.symbol, pos.token_address, pos.amount, pos.price_usd, pos.value_usd, pos.apy_base);
}

async function getLpPrice(meta, chainId) {
  // Calculate LP price from pool liquidity and total supply
  const liquidityUsd = meta.liquidity?.usd;
  if (!liquidityUsd) return 0;
  
  // Get total supply from market contract
  const cfg = PENDLE_CHAINS[Object.keys(PENDLE_CHAINS).find(k => PENDLE_CHAINS[k].chainId === chainId)];
  if (!cfg?.alchemy || !ALCHEMY_KEY) return 0;
  
  try {
    const res = await fetchJSON(`${cfg.alchemy}${ALCHEMY_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_call',
        params: [{ to: meta.marketAddress, data: '0x18160ddd' }, 'latest'] // totalSupply()
      }),
    }, 1);
    if (!res?.result || res.result === '0x') return 0;
    const totalSupply = BigInt(res.result);
    // Pendle LP tokens report 18 decimals but actually use 6 decimals
    // Verify by checking if total supply makes sense with 6 decimals
    const decimals = 6; // Force 6 decimals for Pendle LP
    const totalSupplyNum = Number(totalSupply) / (10 ** decimals);
    if (totalSupplyNum <= 0) return 0;
    return liquidityUsd / totalSupplyNum;
  } catch (e) {
    return 0;
  }
}

async function makePosition(wallet, label, meta, tokenType, tokenAddress, amountRaw) {
  const token = meta[tokenType];
  const amountBn = BigInt(amountRaw);
  const decimals = token?.decimals ?? 18;
  const amount = Number(amountBn) / (10 ** decimals);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  
  let priceUsd = Number(token?.price?.usd || 0);
  if (tokenType === 'lp' && priceUsd === 0) {
    priceUsd = await getLpPrice(meta, meta.chainId);
  }
  
  const valueUsd = amount * priceUsd;
  const dte = daysToExpiry(meta.expiry);

  if (tokenType === 'pt') {
    return {
      wallet,
      label,
      chain: meta.chain,
      chainId: meta.chainId,
      protocol_id: 'pendle-pt',
      protocol_name: 'Pendle',
      position_type: 'supply',
      strategy: 'pendle-pt',
      yield_source: 'pendle',
      position_index: `${meta.marketAddress}:pt:${tokenAddress}`,
      token_address: tokenAddress,
      symbol: token?.symbol || 'PT',
      amount,
      price_usd: priceUsd,
      value_usd: valueUsd,
      net_usd: valueUsd,
      asset_usd: valueUsd,
      apy_base: Number(meta.details?.impliedApy || 0) * 100,
      expiry: meta.expiry,
      days_to_expiry: dte,
    };
  }

  if (tokenType === 'yt') {
    return {
      wallet,
      label,
      chain: meta.chain,
      chainId: meta.chainId,
      protocol_id: 'pendle-yt',
      protocol_name: 'Pendle',
      position_type: 'supply',
      strategy: 'pendle-yt',
      yield_source: 'pendle',
      position_index: `${meta.marketAddress}:yt:${tokenAddress}`,
      token_address: tokenAddress,
      symbol: token?.symbol || 'YT',
      amount,
      price_usd: priceUsd,
      value_usd: valueUsd,
      net_usd: valueUsd,
      asset_usd: valueUsd,
      apy_base: Number(meta.details?.ytFloatingApy || 0) * 100,
      expiry: meta.expiry,
      days_to_expiry: dte,
    };
  }

  return {
    wallet,
    label,
    chain: meta.chain,
    chainId: meta.chainId,
    protocol_id: 'pendle-lp',
    protocol_name: 'Pendle',
    position_type: 'supply',
    strategy: 'pendle-lp',
    yield_source: 'pendle',
    position_index: `${meta.marketAddress}:lp`,
    token_address: tokenAddress,
    symbol: meta.symbol || 'PENDLE-LPT',
    amount,
    price_usd: priceUsd,
    value_usd: valueUsd,
    net_usd: valueUsd,
    asset_usd: valueUsd,
    apy_base: Number(meta.details?.aggregatedApy || meta.details?.impliedApy || 0) * 100,
    expiry: meta.expiry,
    days_to_expiry: dte,
  };
}

async function getDirectBalance(token, wallet, chain) {
  const cfg = PENDLE_CHAINS[chain];
  if (!cfg?.alchemy || !ALCHEMY_KEY) return null;
  const res = await fetchJSON(`${cfg.alchemy}${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [{ to: token, data: '0x70a08231000000000000000000000000' + wallet.slice(2) }, 'latest']
    }),
  }, 1);
  if (!res?.result || res.result === '0x') return null;
  return res.result;
}

async function scanWallet(db, wallet, label, registry) {
  console.log(`\n--- ${label} (${wallet.slice(0, 12)}) ---`);
  const found = [];
  const foundAddrs = new Set();

  for (const [chain, maps] of Object.entries(registry)) {
    if (!maps) continue;

    // Non-authoritative helper only. Useful when Alchemy already knows the token,
    // but V1 truth comes from direct balanceOf checks below.
    const balances = await getBalances(wallet, chain);
    const hinted = new Map();
    for (const bal of balances || []) {
      const amountHex = bal.tokenBalance;
      const addr = String(bal.contractAddress || '').toLowerCase();
      if (!addr || !amountHex || amountHex === '0x0' || amountHex === '0x00') continue;
      hinted.set(addr, amountHex);
    }

    for (const item of maps.direct || []) {
      const addr = item.addr;
      if (foundAddrs.has(addr)) continue;

      const hintedHex = hinted.get(addr);
      const amountHex = hintedHex || await getDirectBalance(addr, wallet, chain);
      if (!amountHex || amountHex === '0x0' || amountHex === '0x00') continue;

      const pos = await makePosition(wallet, label, item.meta, item.type, addr, amountHex);
      if (!pos) continue;

      // V1: only keep LP when directly observed with non-trivial value.
      // PT/YT remain authoritative.
      if (item.type === 'lp' && (!Number.isFinite(pos.value_usd) || pos.value_usd < 100)) {
        continue;
      }

      found.push(pos);
      foundAddrs.add(addr);
      const suffix = hintedHex ? '' : ' (direct)';
      console.log(`  ${chain} ${item.type.toUpperCase()} ${pos.symbol} $${pos.value_usd.toFixed(2)}${suffix}`);
    }
  }

  const tx = db.transaction(() => {
    for (const pos of found) upsertPosition(db, pos);
  });
  tx();

  if (!found.length) console.log('  No Pendle positions');
  return found;
}

// Intentionally no destructive DeBank cleanup here.
// Pendle scanner currently owns direct PT/YT discovery only.
// Keep generic DeBank Pendle rows as fallback until LP / plasma / wrapped exposure is modeled cleanly.

async function main() {
  const db = new Database(DB_PATH);

  // Clean stale zero-value Pendle positions from previous runs (delete child tokens first)
  const staleIds = db.prepare(`SELECT id FROM positions WHERE protocol_name = 'Pendle' AND net_usd = 0`).all().map(r => r.id);
  if (staleIds.length > 0) {
    const placeholders = staleIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM position_tokens WHERE position_id IN (${placeholders})`).run(...staleIds);
    db.prepare(`DELETE FROM positions WHERE id IN (${placeholders})`).run(...staleIds);
    console.log(`  Cleaned ${staleIds.length} stale zero-value Pendle positions`);
  }

  const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
  const walletMap = [];

  for (const [name, config] of Object.entries(whales)) {
    const wallets = Array.isArray(config)
      ? config
      : (config.vaults ? Object.values(config.vaults).flat() : []);
    for (const w of wallets) walletMap.push({ addr: w.toLowerCase(), label: name });
  }

  console.log('=== Pendle v1 Scanner ===');
  console.log('Loading Pendle market registry...');
  const registry = await buildPendleRegistry();
  console.log(`Scanning ${walletMap.length} wallets`);

  let total = 0;
  for (const w of walletMap) {
    const found = await scanWallet(db, w.addr, w.label, registry);
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

module.exports = { buildPendleRegistry, scanWallet };
