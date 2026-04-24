#!/usr/bin/env node
/**
 * compound-scanner.js — Compound V3 (Comet) scanner.
 *
 * Compound III is a single-asset borrowing protocol. Each "market" is a
 * Comet contract where users deposit a base asset (USDC, WETH, etc.) to
 * earn, and post other assets as collateral to borrow the base.
 *
 * The Comet proxy contract itself IS the rebasing ERC-20 share token:
 *   - `balanceOf(wallet)` returns the wallet's supply balance in base-asset
 *     underlying units (already rebasing-adjusted).
 *   - `borrowBalanceOf(wallet)` returns the wallet's debt in base-asset
 *     underlying units.
 *   - `baseToken()` returns the base asset (USDC, etc.).
 *
 * So we don't need to convert shares — balance * price(base) is the USD value.
 *
 * APY: `utilization()` + `getSupplyRate(utilization)` / `getBorrowRate(utilization)`
 * return per-second rates in 1e18-scaled format. Annualize: rate * 31536000 / 1e18.
 *
 * Docs: https://docs.compound.finance/
 * Deployments: https://github.com/compound-finance/comet/tree/main/deployments
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const RECON_PATH = path.join(__dirname, '..', 'data', 'recon', 'alchemy-token-discovery.json');
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
const DRPC_KEY = process.env.DRPC_API_KEY || '';

// RPC endpoints per chain. Alchemy for well-supported chains, dRPC for the rest.
const RPCS = {
  eth: ALCHEMY_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : '',
  arb: ALCHEMY_KEY ? `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : '',
  base: ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : '',
  poly: ALCHEMY_KEY ? `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : '',
  opt: ALCHEMY_KEY ? `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : '',
  scroll: ALCHEMY_KEY ? `https://scroll-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : '',
  mnt: DRPC_KEY ? `https://lb.drpc.live/mantle/${DRPC_KEY}` : '',
};

/**
 * Known Compound V3 Comet markets.
 *
 * Source: official Compound deployments repo + Compound documentation.
 * https://github.com/compound-finance/comet/tree/main/deployments
 *
 * Each entry: { comet, chain, base_symbol, base_address, base_decimals }
 *
 * New markets ship ~quarterly. If we see a DeBank position with pool.id
 * that's not in this list, add it here.
 */
const COMET_MARKETS = [
  // Ethereum
  { comet: '0xc3d688b66703497daa19211eedff47f25384cdc3', chain: 'eth',  base_symbol: 'USDC',     base_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', base_decimals: 6 },  // cUSDCv3
  { comet: '0xa17581a9e3356d9a858b789d68b4d866e593ae94', chain: 'eth',  base_symbol: 'WETH',     base_address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', base_decimals: 18 }, // cWETHv3
  { comet: '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840', chain: 'eth',  base_symbol: 'USDT',     base_address: '0xdac17f958d2ee523a2206206994597c13d831ec7', base_decimals: 6 },  // cUSDTv3
  { comet: '0x5d409e56d886231adaf00c8775665ad0f9897b56', chain: 'eth',  base_symbol: 'USDS',     base_address: '0xdc035d45d973e3ec169d2276ddab16f1e407384f', base_decimals: 18 }, // cUSDSv3
  { comet: '0x3d0bb1ccab9e54a701f133a4a533e4d2ef6a02bf', chain: 'eth',  base_symbol: 'wstETH',   base_address: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', base_decimals: 18 }, // cwstETHv3
  { comet: '0xe85dc543813b8c2cfeaac371517b925a166a9293', chain: 'eth',  base_symbol: 'WBTC',     base_address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', base_decimals: 8 },  // cWBTCv3

  // Base
  { comet: '0xb125e6687d4313864e53df431d5425969c15eb2f', chain: 'base', base_symbol: 'USDbC',    base_address: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', base_decimals: 6 },
  { comet: '0xb2d3e9c8c19a23a1aa0a7b9b7c6a4a4e8e4e4e4e', chain: 'base', base_symbol: 'USDC',     base_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', base_decimals: 6 },
  { comet: '0x46e6b214b524310239732d51387075e0e70970bf', chain: 'base', base_symbol: 'WETH',     base_address: '0x4200000000000000000000000000000000000006', base_decimals: 18 },
  { comet: '0x784efeb622244d2348d4f2522f8860b96fbece89', chain: 'base', base_symbol: 'AERO',     base_address: '0x940181a94a35a4569e4529a3cdfb74e38fd98631', base_decimals: 18 },

  // Arbitrum
  { comet: '0xa5edbdd9646f8dff606d7448e414884c7d905dca', chain: 'arb',  base_symbol: 'USDC.e',   base_address: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', base_decimals: 6 },
  { comet: '0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf', chain: 'arb',  base_symbol: 'USDC',     base_address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', base_decimals: 6 },
  { comet: '0x6f7d514bbd4aff3bcd1140b7344b32f063dee486', chain: 'arb',  base_symbol: 'WETH',     base_address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', base_decimals: 18 },
  { comet: '0xd98be00b5d27fc98112bde293e487f8d4ca57d07', chain: 'arb',  base_symbol: 'USDT',     base_address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', base_decimals: 6 },

  // Polygon
  { comet: '0xf25212e676d1f7f89cd72ffee66158f541246445', chain: 'poly', base_symbol: 'USDC.e',   base_address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', base_decimals: 6 },
  { comet: '0xaec1f48e02cfb822be958b68c7957156eb3f0b6e', chain: 'poly', base_symbol: 'USDT',     base_address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', base_decimals: 6 },

  // Optimism
  { comet: '0x2e44e174f7d53f0212823acc11c01a11d58c5bcb', chain: 'opt',  base_symbol: 'USDC',     base_address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', base_decimals: 6 },
  { comet: '0x995e394b8b2437ac8ce61ee0bc610d617962b214', chain: 'opt',  base_symbol: 'USDT',     base_address: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', base_decimals: 6 },
  { comet: '0xe36a30d249f7761327fd973001a32010b521b6fd', chain: 'opt',  base_symbol: 'WETH',     base_address: '0x4200000000000000000000000000000000000006', base_decimals: 18 },

  // Scroll
  { comet: '0xb2f97c1bd3bf02f5e74d13f02e3e26f93d77ce44', chain: 'scroll', base_symbol: 'USDC',   base_address: '0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4', base_decimals: 6 },

  // Mantle
  { comet: '0x606174f62cd968d8e684c645080fa694c1d7786e', chain: 'mnt',  base_symbol: 'USDe',     base_address: '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34', base_decimals: 18 },
];

const SECONDS_PER_YEAR = 365 * 24 * 3600;

// Selectors (verified via keccak256 of the function signatures)
const SEL_BALANCE_OF     = '0x70a08231'; // balanceOf(address)
const SEL_BORROW_BAL_OF  = '0x374c49b4'; // borrowBalanceOf(address)
const SEL_UTILIZATION    = '0x7eb71131'; // getUtilization()
const SEL_SUPPLY_RATE    = '0xd955759d'; // getSupplyRate(uint256)
const SEL_BORROW_RATE    = '0x9fa83b5a'; // getBorrowRate(uint256)

function padAddress(addr) {
  return addr.slice(2).toLowerCase().padStart(64, '0');
}

function padUint(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

async function rpcCall(url, to, data) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    const body = await res.json();
    if (body.error || !body.result || body.result === '0x') return null;
    return body.result;
  } catch { return null; }
}

async function batchCall(url, calls) {
  // calls: [{to, data}] -> returns [{result | null}]
  const batch = calls.map((c, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_call',
    params: [{ to: c.to, data: c.data }, 'latest'],
  }));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    const body = await res.json();
    const arr = Array.isArray(body) ? body : [body];
    const out = new Array(calls.length).fill(null);
    for (const r of arr) {
      if (r?.id != null && !r.error && r.result && r.result !== '0x') out[r.id] = r.result;
    }
    return out;
  } catch { return new Array(calls.length).fill(null); }
}

async function getDefiLlamaPrice(chain, address) {
  const chainMap = { eth: 'ethereum', arb: 'arbitrum', base: 'base', poly: 'polygon',
    opt: 'optimism', scroll: 'scroll', mnt: 'mantle' };
  const dlChain = chainMap[chain] || chain;
  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/${dlChain}:${address.toLowerCase()}`);
    const d = await res.json();
    return d?.coins?.[`${dlChain}:${address.toLowerCase()}`]?.price || null;
  } catch { return null; }
}

function writePosition(db, { wallet, chain, comet, baseSymbol, supplyAmount, borrowAmount, basePrice, apySupply, apyBorrow }) {
  const supplyUsd = supplyAmount * (basePrice || 1);
  const borrowUsd = borrowAmount * (basePrice || 1);
  const netUsd = supplyUsd - borrowUsd;

  const positionIndex = `${chain}:compound3:${comet.toLowerCase()}`;

  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE lower(wallet) = ? AND chain = ? AND protocol_id = 'compound3' AND position_index = ?
  `).get(wallet.toLowerCase(), chain, positionIndex);

  let posId;
  const strategy = borrowAmount > 0 ? 'lend-borrow' : 'lend';
  if (existing) {
    db.prepare(`
      UPDATE positions
      SET asset_usd = ?, debt_usd = ?, net_usd = ?,
          protocol_name = 'Compound V3', position_type = 'Lending',
          strategy = ?, yield_source = ?, scanned_at = datetime('now')
      WHERE id = ?
    `).run(supplyUsd, borrowUsd, netUsd, strategy, `compound3:${baseSymbol}`, existing.id);
    posId = existing.id;
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(posId);
  } else {
    const res = db.prepare(`
      INSERT INTO positions (
        wallet, chain, protocol_id, protocol_name, position_type, strategy,
        yield_source, net_usd, asset_usd, debt_usd, position_index, scanned_at
      ) VALUES (?, ?, 'compound3', 'Compound V3', 'Lending', ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(wallet.toLowerCase(), chain, strategy, `compound3:${baseSymbol}`, netUsd, supplyUsd, borrowUsd, positionIndex);
    posId = res.lastInsertRowid;
  }

  // Supply row (if any)
  if (supplyAmount > 0) {
    db.prepare(`
      INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
      VALUES (?, 'supply', ?, NULL, ?, ?, ?, ?)
    `).run(posId, baseSymbol, supplyAmount, basePrice || 0, supplyUsd, apySupply);
  }
  // Borrow row (if any)
  if (borrowAmount > 0) {
    db.prepare(`
      INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
      VALUES (?, 'borrow', ?, NULL, ?, ?, ?, ?)
    `).run(posId, baseSymbol, borrowAmount, basePrice || 0, borrowUsd, apyBorrow);
  }

  return posId;
}

async function scanMarket(db, cometInfo, wallets) {
  const url = RPCS[cometInfo.chain];
  if (!url) { return { hits: 0, totalNet: 0 }; }

  // First, get market-wide APY (one batch of 3 calls: utilization, supplyRate, borrowRate)
  const utilHex = await rpcCall(url, cometInfo.comet, SEL_UTILIZATION);
  let apySupply = null, apyBorrow = null;
  if (utilHex) {
    const util = BigInt(utilHex);
    // getSupplyRate(uint256) & getBorrowRate(uint256)
    const rateBatch = await batchCall(url, [
      { to: cometInfo.comet, data: SEL_SUPPLY_RATE + util.toString(16).padStart(64, '0') },
      { to: cometInfo.comet, data: SEL_BORROW_RATE + util.toString(16).padStart(64, '0') },
    ]);
    if (rateBatch[0]) apySupply = Number(BigInt(rateBatch[0])) / 1e18 * SECONDS_PER_YEAR * 100;
    if (rateBatch[1]) apyBorrow = Number(BigInt(rateBatch[1])) / 1e18 * SECONDS_PER_YEAR * 100;
  }

  // Batch balanceOf + borrowBalanceOf for every wallet
  const calls = [];
  for (const w of wallets) {
    calls.push({ to: cometInfo.comet, data: SEL_BALANCE_OF + padAddress(w) });
    calls.push({ to: cometInfo.comet, data: SEL_BORROW_BAL_OF + padAddress(w) });
  }
  const results = await batchCall(url, calls);

  // Price of base asset (one call per market)
  const basePrice = await getDefiLlamaPrice(cometInfo.chain, cometInfo.base_address);

  let hits = 0, totalNet = 0;
  for (let i = 0; i < wallets.length; i++) {
    const supplyHex = results[i * 2];
    const borrowHex = results[i * 2 + 1];
    const supplyRaw = supplyHex ? BigInt(supplyHex) : 0n;
    const borrowRaw = borrowHex ? BigInt(borrowHex) : 0n;
    if (supplyRaw === 0n && borrowRaw === 0n) continue;

    const supplyAmt = Number(supplyRaw) / Math.pow(10, cometInfo.base_decimals);
    const borrowAmt = Number(borrowRaw) / Math.pow(10, cometInfo.base_decimals);

    const wallet = wallets[i];
    const supplyUsd = supplyAmt * (basePrice || 1);
    const borrowUsd = borrowAmt * (basePrice || 1);
    const netUsd = supplyUsd - borrowUsd;
    if (Math.abs(netUsd) < 1000) continue; // dust

    writePosition(db, {
      wallet, chain: cometInfo.chain, comet: cometInfo.comet,
      baseSymbol: cometInfo.base_symbol,
      supplyAmount: supplyAmt, borrowAmount: borrowAmt,
      basePrice, apySupply, apyBorrow,
    });

    hits++;
    totalNet += netUsd;
    const role = borrowAmt > 0 ? (supplyAmt > 0 ? 'supply+borrow' : 'borrow') : 'supply';
    console.log(`  🟢 C3 ${cometInfo.chain.padEnd(6)} ${cometInfo.base_symbol.padEnd(8)} ${wallet.slice(0, 10)} ${role.padEnd(14)} supply=$${(supplyUsd / 1e6).toFixed(3)}M borrow=$${(borrowUsd / 1e6).toFixed(3)}M net=$${(netUsd / 1e6).toFixed(3)}M apy=${apySupply?.toFixed(2) || '?'}%`);
  }
  return { hits, totalNet };
}

function cleanupStaleForWallets(db, scannedWallets) {
  // Drop compound3 rows where the (wallet, chain, position_index) wasn't re-touched
  // this run. The scanner re-touches everything it finds via writePosition, so
  // anything with an old scanned_at among the scanned wallets is a ghost.
  const walletSet = new Set(scannedWallets.map(w => w.toLowerCase()));
  if (walletSet.size === 0) return;
  const placeholders = Array(walletSet.size).fill('?').join(',');
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m
  const stale = db.prepare(`
    SELECT id FROM positions
    WHERE protocol_id = 'compound3'
      AND lower(wallet) IN (${placeholders})
      AND scanned_at < ?
  `).all(...walletSet, cutoff);
  for (const r of stale) {
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(r.id);
    db.prepare('DELETE FROM positions WHERE id = ?').run(r.id);
  }
  if (stale.length) console.log(`Cleaned ${stale.length} stale compound3 rows`);
}

async function main() {
  if (!ALCHEMY_KEY) { console.error('Missing ALCHEMY_API_KEY'); process.exit(1); }

  const db = new Database(DB_PATH);

  // Load all active wallets from the recon file — we don't need tokens, just
  // the (wallet, chain) pairs. Alternative: DeBank summary. Recon is the
  // right source because it's already gated on "active for scan".
  let recon;
  try { recon = JSON.parse(fs.readFileSync(RECON_PATH, 'utf8')); }
  catch { console.error('Missing alchemy-token-discovery.json. Run build-alchemy-recon first.'); process.exit(1); }

  // Group wallets by chain
  const walletsByChain = {};
  for (const w of recon.wallets || []) {
    const chain = w.chain;
    if (!RPCS[chain]) continue;
    (walletsByChain[chain] = walletsByChain[chain] || new Set()).add(w.wallet.toLowerCase());
  }

  console.log('=== Compound V3 scanner ===');
  console.log(`Markets tracked: ${COMET_MARKETS.length}`);
  for (const [chain, set] of Object.entries(walletsByChain)) {
    console.log(`  ${chain}: ${set.size} active wallets`);
  }
  console.log();

  let totalHits = 0, totalNet = 0;
  const scannedWallets = [];

  for (const market of COMET_MARKETS) {
    const wallets = [...(walletsByChain[market.chain] || [])];
    if (wallets.length === 0) continue;
    const { hits, totalNet: marketNet } = await scanMarket(db, market, wallets);
    totalHits += hits;
    totalNet += marketNet;
    for (const w of wallets) scannedWallets.push(w);
  }

  cleanupStaleForWallets(db, [...new Set(scannedWallets)]);

  console.log(`\nCompound V3 positions: ${totalHits} found`);
  console.log(`Total Compound V3 net: $${(totalNet / 1e6).toFixed(2)}M`);
  db.close();
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
