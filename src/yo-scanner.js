#!/usr/bin/env node
/**
 * YO Protocol Scanner
 *
 * YO Protocol (app.yo.xyz) is a multi-chain yield optimizer with 4 vaults
 * (USD, ETH, BTC, EURC) deployed on Ethereum, Base, and Arbitrum. Each
 * vault is an ERC-4626 that holds underlying assets and deploys them
 * into other protocols (Morpho, Aave, Euler, Fluid, etc.) via strategy
 * modules. DefiLlama TVL ≈ sum of totalAssets() across all vaults.
 *
 * Our ordinary wallet scanner treats `0x0000000f2eb9f6...` (yoUSD) as
 * a user wallet and only captures tokens it directly holds + Morpho
 * earn positions it has opened. That misses the bulk of the TVL because
 * most assets are deployed via AlchemistCS (internal) or non-Morpho paths.
 *
 * Correct approach: directly call totalAssets() on each YO vault and
 * record as a single protocol-api position per vault per chain.
 *
 * Source: https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/yo/index.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

const RPCS = {
  eth: 'https://eth-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
  base: 'https://base-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
  arb: 'https://arb-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
};

// Only yoUSD for now. Other YO vaults (yoETH, yoBTC, yoEURC, yoGOLD) are
// documented in defillama/projects/yo/index.js and can be re-enabled if
// we want to track them as separate whales later.
const VAULTS = {
  eth: [
    { address: '0x0000000f2eB9f69274678c76222B35eEc7588a65', name: 'yoUSD' },
  ],
  base: [
    { address: '0x0000000f2eB9f69274678c76222B35eEc7588a65', name: 'yoUSD' },
  ],
  arb: [],
};

// Canonical price sources. Keep minimal and use on-chain data where possible.
// For simplicity we use CoinGecko simple-price for underlying tokens by id.
async function getPrices() {
  const ids = 'usd-coin,ethereum,bitcoin,euro-coin,pax-gold,tether-gold';
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const d = await r.json();
    const gold = d['tether-gold']?.usd || d['pax-gold']?.usd || 3300;
    return {
      USDC: d['usd-coin']?.usd || 1,
      WETH: d.ethereum?.usd || 3000,
      WBTC: d.bitcoin?.usd || 90000,
      cbBTC: d.bitcoin?.usd || 90000,
      EURC: d['euro-coin']?.usd || 1.1,
      PAXG: d['pax-gold']?.usd || 3300,
      XAUt: gold,
    };
  } catch (e) {
    console.log('price fetch failed, using fallback defaults');
    return { USDC: 1, WETH: 3000, WBTC: 90000, cbBTC: 90000, EURC: 1.1, PAXG: 3300, XAUt: 3300 };
  }
}

async function rpcCall(url, to, data) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const d = await r.json();
  return d.result;
}

async function scanVault(chain, vault, prices) {
  const url = RPCS[chain];
  const addr = vault.address;

  // totalAssets() selector 0x01e1d114
  const taHex = await rpcCall(url, addr, '0x01e1d114');
  if (!taHex || taHex === '0x') return null;
  const totalAssets = BigInt(taHex);
  if (totalAssets === 0n) return null;

  // asset()
  const assetHex = await rpcCall(url, addr, '0x38d52e0f');
  const underlying = '0x' + (assetHex || '').slice(-40).toLowerCase();
  if (!underlying || underlying === '0x') return null;

  // decimals() and symbol() on underlying
  const [decHex, symHex] = await Promise.all([
    rpcCall(url, underlying, '0x313ce567'),
    rpcCall(url, underlying, '0x95d89b41'),
  ]);
  const decimals = parseInt(decHex || '0x12', 16);
  // Parse ABI-encoded string for symbol (offset 0x20 + length + data)
  let symbol = '?';
  try {
    if (symHex && symHex.length > 130) {
      const len = parseInt(symHex.slice(66, 130), 16);
      const hex = symHex.slice(130, 130 + len * 2);
      symbol = Buffer.from(hex, 'hex').toString('utf8').trim();
    }
  } catch (e) {}

  const amount = Number(totalAssets) / (10 ** decimals);
  const price = prices[symbol] || (symbol.startsWith('y') ? 1 : 0);
  const valueUsd = amount * price;

  return {
    vault_address: addr.toLowerCase(),
    vault_name: vault.name,
    chain,
    underlying_address: underlying,
    underlying_symbol: symbol,
    amount,
    price,
    value_usd: valueUsd,
  };
}

// Fetch the latest allocation breakdown from the yo.xyz public API.
// The API returns the GLOBAL allocation (same for all chains) — yoUSD
// has a master vault on Base and a secondary vault on ETH that bridges
// funds, so the deployments live in one shared strategy registry.
async function fetchYoAllocations(network, vaultAddr) {
  const url = `https://api.yo.xyz/api/v1/vault/allocations/timeseries/${network}/${vaultAddr}`;
  try {
    const res = await fetch(url, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'origin': 'https://app.yo.xyz',
        'referer': 'https://app.yo.xyz/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    if (!res.ok) return null;
    const d = await res.json();
    const items = d.data || [];
    return items[items.length - 1] || null;  // latest snapshot
  } catch { return null; }
}

// Heuristic: parse strategy name → chain. The yo.xyz API doesn't tell us
// which chain each strategy lives on, so we infer from the name suffix.
function strategyChain(name) {
  if (/Unichain/i.test(name)) return 'uni';
  if (/Base$/i.test(name) || /baseUSD/i.test(name)) return 'base';
  // ETH-only markets per yo.xyz UI confirmation:
  if (/wstETH\/USDT/i.test(name)) return 'eth';
  // Bare USDT line (small idle balance) sits on ETH per UI
  if (/^USDT$/i.test(name)) return 'eth';
  // Default: master vault chain
  return 'base';
}

// Heuristic: parse strategy name → primary supply token symbol.
function strategyToken(name) {
  // "Morpho cbBTC/USDC Market Base" → cbBTC + USDC
  // "Morpho WETH/USDC Market" → WETH + USDC
  // "Aave sGHO" → sGHO; "Resolv RLP" → RLP
  const slashMatch = name.match(/([A-Za-z0-9]+)\/([A-Za-z0-9]+)/);
  if (slashMatch) return slashMatch[1] + '+' + slashMatch[2];
  if (/^USDT$/i.test(name)) return 'USDT';
  const lastWord = name.split(/\s+/).pop();
  return lastWord || 'USDC';
}

function savePositions(db, results, allocation) {
  // Clean all existing YO-protocol rows first (FK-safe order)
  const oldIds = db.prepare(`SELECT id FROM positions WHERE protocol_id = 'yo-protocol'`).all();
  const delTok = db.prepare(`DELETE FROM position_tokens WHERE position_id = ?`);
  const delMkt = db.prepare(`DELETE FROM position_markets WHERE position_id = ?`);
  const delPos = db.prepare(`DELETE FROM positions WHERE id = ?`);
  for (const r of oldIds) { delTok.run(r.id); delMkt.run(r.id); delPos.run(r.id); }

  const upsertPos = db.prepare(`
    INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, net_usd, asset_usd, debt_usd, position_index, scanned_at)
    VALUES (?, ?, 'yo-protocol', ?, 'Vault', 'vault', ?, ?, 0, ?, datetime('now'))
    ON CONFLICT(wallet, chain, protocol_id, position_index) DO UPDATE SET
      protocol_name = excluded.protocol_name,
      position_type = 'Vault', strategy = 'vault',
      net_usd = excluded.net_usd, asset_usd = excluded.asset_usd, scanned_at = datetime('now')
  `);
  const findPos = db.prepare(`SELECT id FROM positions WHERE lower(wallet) = ? AND chain = ? AND protocol_id = 'yo-protocol' AND position_index = ?`);
  const insertToken = db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, value_usd, apy_base, bonus_supply_apy)
    VALUES (?, 'supply', ?, ?, ?, ?, NULL, NULL)
  `);

  // Total TVL across all yo vault chains (master + secondary)
  const totalUsd = results.reduce((s, r) => s + r.value_usd, 0);
  const wallet = results[0]?.vault_address.toLowerCase();
  const underlying = results[0]?.underlying_address;

  if (allocation && allocation.protocols && totalUsd > 0) {
    // Per-strategy breakdown rows from yo.xyz API
    let allocatedPct = 0;
    for (const [protoName, pctStr] of Object.entries(allocation.protocols)) {
      const pct = parseFloat(pctStr);
      if (!isFinite(pct) || pct <= 0) continue;
      allocatedPct += pct;
      const chain = strategyChain(protoName);
      const valueUsd = totalUsd * pct / 100;
      const tokenSymbol = strategyToken(protoName);
      const idx = `yoUSD|${protoName}`;
      const protocolName = `yoUSD → ${protoName}`;
      upsertPos.run(wallet, chain, protocolName, valueUsd, valueUsd, idx);
      const pos = findPos.get(wallet, chain, idx);
      if (pos?.id) {
        insertToken.run(pos.id, tokenSymbol, underlying, null, valueUsd);
      }
    }
    // Idle USDC = remainder (allocations from yo.xyz API don't sum to 100%)
    const idlePct = 100 - allocatedPct;
    if (idlePct > 0.01) {
      const idleUsd = totalUsd * idlePct / 100;
      const idx = `yoUSD|Idle USDC`;
      upsertPos.run(wallet, 'base', 'yoUSD → Idle USDC', idleUsd, idleUsd, idx);
      const pos = findPos.get(wallet, 'base', idx);
      if (pos?.id) insertToken.run(pos.id, 'USDC', underlying, null, idleUsd);
    }
  } else {
    // Fallback: no allocation API — keep the per-chain totalAssets rows
    for (const r of results) {
      const idx = `${r.chain}|${r.vault_name}|totalAssets`;
      upsertPos.run(wallet, r.chain, r.vault_name, r.value_usd, r.value_usd, idx);
      const pos = findPos.get(wallet, r.chain, idx);
      if (pos?.id) insertToken.run(pos.id, r.underlying_symbol, r.underlying_address, r.amount, r.value_usd);
    }
  }
}

async function main() {
  console.log('=== YO Protocol Scanner ===');
  const prices = await getPrices();
  console.log('Prices:', prices);

  const results = [];
  for (const [chain, vaults] of Object.entries(VAULTS)) {
    if (!vaults.length) continue;
    console.log(`\n[${chain}]`);
    for (const v of vaults) {
      try {
        const r = await scanVault(chain, v, prices);
        if (r && r.value_usd > 0) {
          console.log(`  ${v.name.padEnd(8)} ${r.amount.toFixed(4)} ${r.underlying_symbol} = $${(r.value_usd/1e6).toFixed(2)}M`);
          results.push(r);
        } else {
          console.log(`  ${v.name.padEnd(8)} (empty or missing)`);
        }
      } catch (e) {
        console.log(`  ${v.name} ERR: ${e.message}`);
      }
    }
  }

  const total = results.reduce((s, r) => s + r.value_usd, 0);
  console.log(`\n=== Total YO TVL: $${(total/1e6).toFixed(2)}M ===`);

  // Fetch the strategy allocation breakdown from yo.xyz API.
  // Same allocation applies to base + ETH master/secondary vaults.
  const allocation = results[0]
    ? await fetchYoAllocations('base', results[0].vault_address)
    : null;
  if (allocation?.protocols) {
    console.log('\nAllocation breakdown:');
    for (const [k, v] of Object.entries(allocation.protocols)) {
      console.log(`  ${k.padEnd(40)} ${v}% = $${(total * parseFloat(v) / 100 / 1e6).toFixed(2)}M`);
    }
  } else {
    console.log('\nNo allocation breakdown — falling back to single-row per chain');
  }

  const db = new Database(DB_PATH);
  savePositions(db, results, allocation);
  db.close();
  const rowCount = allocation?.protocols ? Object.keys(allocation.protocols).length + 1 : results.length;
  console.log(`Saved ${rowCount} yo-protocol position rows`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { scanVault, savePositions };
