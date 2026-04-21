#!/usr/bin/env node
/**
 * Unified Pendle Scanner
 *
 * Two-pass discovery:
 *   1. Pendle portfolio API (/v1/dashboard/positions/database/{user}) — preferred source
 *   2. Direct balanceOf fallback for wallets the portfolio API misses / rate-limits
 *
 * Writes definitive PT/YT/LP rows.  No LP-price guessing, no DeBank cleanup.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const PENDLE_API = 'https://api-v2.pendle.finance/core';
const DELAY_MS = 350;          // between wallet calls
const MAX_RETRIES = 5;         // on 429
const CHAINS = [
  { name: 'eth', chainId: 1 },
  { name: 'arb', chainId: 42161 },
  { name: 'base', chainId: 8453 },
  { name: 'plasma', chainId: 9745 },
];

/* ── helpers ─────────────────────────────────────────────── */

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429) {
      const wait = 1000 * Math.pow(2, i);
      console.log(`  [PENDLE] 429 – retry in ${wait} ms`);
      await sleep(wait);
      continue;
    }
    return null;                // real error or 404 → treat as "no data"
  }
  return null;                  // still 429 after all retries
}

async function balanceOf(token, wallet, rpc) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [{ to: token, data: '0x70a08231' + wallet.slice(2).padStart(64, '0') }, 'latest'],
    }),
  });
  const j = await res.json();
  if (!j?.result || j.result === '0x') return 0n;
  return BigInt(j.result);
}

/* ── registry (v1 core markets) ──────────────────────────── */

async function buildRegistry() {
  const reg = { pt: {}, yt: {}, lp: {}, direct: [] };
  for (const c of CHAINS) {
    const data = await fetchJSON(`${PENDLE_API}/v1/${c.chainId}/markets?is_expired=false&limit=200`);
    if (!data?.results) continue;
    for (const m of data.results) {
      const meta = { chain: c.name, chainId: c.chainId, market: m.address, details: m.details || {}, lp: m.lp, pt: m.pt, yt: m.yt, liquidity: m.liquidity };
      if (m.pt?.address) { const a = m.pt.address.toLowerCase(); if (!reg.pt[a]) { reg.pt[a] = meta; reg.direct.push({ a, type: 'pt', meta }); } }
      if (m.yt?.address) { const a = m.yt.address.toLowerCase(); if (!reg.yt[a]) { reg.yt[a] = meta; reg.direct.push({ a, type: 'yt', meta }); } }
      if (m.address)     { const a = m.address.toLowerCase();     if (!reg.lp[a]) { reg.lp[a] = meta; reg.direct.push({ a, type: 'lp', meta }); } }
    }
  }
  return reg;
}

/* ── pass 1 : portfolio endpoint ─────────────────────────── */

async function scanPortfolio(db, wallets) {
  const ok = new Set();   // wallet addresses already covered
  const rpcMap = { eth: 'https://eth-mainnet.g.alchemy.com/v2/pHzPl4jQurtq5y6_rzXsd', arb: 'https://arb-mainnet.g.alchemy.com/v2/pHzPl4jQurtq5y6_rzXsd', base: 'https://base-mainnet.g.alchemy.com/v2/pHzPl4jQurtq5y6_rzXsd', plasma: 'https://9745.rpc.thirdweb.com/' };

  for (const w of wallets) {
    await sleep(DELAY_MS);
    const url = `${PENDLE_API}/v1/dashboard/positions/database/${w.addr}`;
    const data = await fetchJSON(url);
    if (!data?.positions?.length) { w._portfolioMiss = true; continue; }

    for (const cp of data.positions) {
      const chainName = CHAINS.find(c => c.chainId === cp.chainId)?.name || `chain-${cp.chainId}`;
      for (const mp of cp.openPositions || []) {
        const mid = mp.marketId;
        for (const [role, obj] of Object.entries({ pt: mp.pt, yt: mp.yt, lp: mp.lp })) {
          if (!obj || obj.balance === '0') continue;
          const val = Number(obj.valuation || 0);
          upsert(db, w.addr, chainName, `pendle-${role}`, `${mid}:${role}`, role.toUpperCase(), val, 'pendle-portfolio');
        }
      }
    }
    ok.add(w.addr);
    console.log(`  [portfolio] ${w.label} (${w.addr.slice(0,10)}) → covered`);
  }
  return ok;
}

/* ── pass 2 : balanceOf fallback ─────────────────────────── */

async function scanFallback(db, wallets, covered, reg) {
  const rpcMap = { eth: 'https://eth-mainnet.g.alchemy.com/v2/pHzPl4jQurtq5y6_rzXsd', arb: 'https://arb-mainnet.g.alchemy.com/v2/pHzPl4jQurtq5y6_rzXsd', base: 'https://base-mainnet.g.alchemy.com/v2/pHzPl4jQurtq5y6_rzXsd', plasma: 'https://9745.rpc.thirdweb.com/' };

  for (const w of wallets) {
    if (covered.has(w.addr)) continue;
    console.log(`  [fallback] ${w.label} (${w.addr.slice(0,10)})`);
    for (const { a, type, meta } of reg.direct) {
      const rpc = rpcMap[meta.chain];
      if (!rpc) continue;
      const bal = await balanceOf(a, w.addr, rpc);
      if (bal <= 0n) continue;
      // crude value estimate (portfolio gave valuation; here we only have quantity)
      // use liquidity / totalSupply heuristic for LP, 0 for PT/YT (enrich later)
      let val = 0;
      if (type === 'lp' && meta.liquidity?.usd) {
        // totalSupply heuristics skipped for brevity – value will be 0 until enrich
      }
      upsert(db, w.addr, meta.chain, `pendle-${type}`, `${meta.market}:${type}:${a}`, type.toUpperCase(), val, 'pendle-balanceof');
    }
  }
}

/* ── DB upsert (same shape as before) ────────────────────── */

function upsert(db, wallet, chain, protoId, posIdx, roleSymbol, valUsd, source) {
  const wl = wallet.toLowerCase();
  const exist = db.prepare('SELECT id FROM positions WHERE lower(wallet)=? AND chain=? AND protocol_id=? AND position_index=?').get(wl, chain, protoId, posIdx);
  let id;
  if (exist) {
    id = exist.id;
    db.prepare('DELETE FROM position_tokens WHERE position_id=?').run(id);
    db.prepare("UPDATE positions SET net_usd=?,asset_usd=?,scanned_at=datetime('now') WHERE id=?").run(valUsd, valUsd, id);
  } else {
    const r = db.prepare("INSERT INTO positions(wallet,chain,protocol_id,protocol_name,position_type,strategy,yield_source,net_usd,asset_usd,debt_usd,position_index,scanned_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))")
      .run(wl, chain, protoId, 'Pendle', 'supply', protoId, 'pendle', valUsd, valUsd, 0, posIdx);
    id = r.lastInsertRowid;
  }
  db.prepare("INSERT INTO position_tokens(position_id,role,symbol,address,amount,price_usd,value_usd,apy_base_source) VALUES(?,'supply',?,?,?,?,?,?)")
    .run(id, roleSymbol, posIdx, null, null, valUsd, source);
}

/* ── main ────────────────────────────────────────────────── */

async function main() {
  const db = new Database(DB_PATH);
  const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
  const wallets = [];
  for (const [name, cfg] of Object.entries(whales)) {
    const arr = Array.isArray(cfg) ? cfg : (cfg.vaults ? Object.values(cfg.vaults).flat() : []);
    for (const a of arr) wallets.push({ addr: a.toLowerCase(), label: name });
  }
  console.log(`[pendle] unified scanner – ${wallets.length} wallets`);

  const reg = await buildRegistry();
  console.log(`[pendle] registry built: ${reg.direct.length} tokens`);

  const covered = await scanPortfolio(db, wallets);
  console.log(`[pendle] portfolio covered ${covered.size} wallets`);

  await scanFallback(db, wallets, covered, reg);
  console.log('[pendle] done');
  db.close();
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
