#!/usr/bin/env node
/**
 * enrich-markets.js
 * Enriches positions with market/vault info from protocol APIs.
 * This enables Merkl campaign matching by market (identifier).
 * 
 * For Aave: queries Aave GraphQL to find which reserve/market a position uses
 * For Euler: queries Goldsky to find which vault a position is in
 * For Morpho: position_index IS the market ID (already done)
 */

const Database = require('better-sqlite3');
const https = require('https');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const AAVE_API = 'https://api.v3.aave.com/graphql';
const GOLDSKY_URLS = {
  eth: 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn',
};

// Generic HTTP POST
function postJSON(url, body) {
  return new Promise((res, rej) => {
    const bodyStr = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(new Error(`Parse: ${d.slice(0,200)}`)); } });
    });
    req.on('error', rej);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Aave: Get all reserves with vToken addresses ─────────────────
async function fetchAaveReserves() {
  const query = `{ markets(request: {chainIds: [1]}) {
    name
    reserves {
      underlyingToken { symbol address decimals }
      aToken { address }
      vToken { address }
    }
  }}`;
  
  const data = await postJSON(AAVE_API, { query });
  const markets = data.data?.markets || [];
  
  // Build lookup: underlying address → [{ market, vToken, aToken }]
  const reserveMap = {};
  for (const market of markets) {
    for (const r of (market.reserves || [])) {
      const addr = r.underlyingToken?.address?.toLowerCase();
      if (!addr) continue;
      if (!reserveMap[addr]) reserveMap[addr] = [];
      reserveMap[addr].push({
        marketName: market.name,
        symbol: r.underlyingToken?.symbol,
        vToken: r.vToken?.address?.toLowerCase(),
        aToken: r.aToken?.address?.toLowerCase(),
      });
    }
  }
  
  return reserveMap;
}

// ─── Aave: Determine which reserve a position uses ────────────────
// DeBank may include vToken addresses in the position data
// We check if position_index or token addresses match any vToken
function findAaveReserve(position, reserveMap) {
  const posIndex = (position.position_index || '').toLowerCase();
  const supplyAddr = position.supply_address?.toLowerCase();
  const borrowAddr = position.borrow_address?.toLowerCase();
  
  // Check if position_index contains a vToken address
  for (const [underlying, reserves] of Object.entries(reserveMap)) {
    for (const r of reserves) {
      if (posIndex.includes(r.vToken?.toLowerCase())) {
        return r;
      }
    }
  }
  
  // Default to first reserve for the underlying
  // This is a fallback — ideally we'd query Aave's user position API
  if (supplyAddr && reserveMap[supplyAddr]) {
    return reserveMap[supplyAddr][0]; // Core market usually first
  }
  if (borrowAddr && reserveMap[borrowAddr]) {
    return reserveMap[borrowAddr][0];
  }
  
  return null;
}

// ─── Euler: Fetch vault info from Goldsky ──────────────────────────
async function fetchEulerVaults(chain = 'eth') {
  const url = GOLDSKY_URLS[chain];
  if (!url) return {};
  
  const data = await postJSON(url, {
    query: '{ eulerVaults(first: 500) { id name symbol asset } }'
  });
  
  const vaults = data.data?.eulerVaults || [];
  
  // Build lookup: vault address → { name, symbol, asset }
  const vaultMap = {};
  for (const v of vaults) {
    vaultMap[v.id?.toLowerCase()] = {
      name: v.name,
      symbol: v.symbol,
      asset: v.asset?.toLowerCase(),
    };
  }
  
  console.log(`  Euler: ${vaults.length} vaults indexed`);
  return vaultMap;
}

// ─── Main enrichment ──────────────────────────────────────────────
async function main() {
  const db = new Database(DB_PATH);
  
  console.log('=== Market Enrichment ===\n');
  
  // 1. Fetch Aave reserves
  console.log('1. Fetching Aave ETH reserves...');
  const aaveReserves = await fetchAaveReserves();
  const reserveCount = Object.values(aaveReserves).reduce((s, r) => s + r.length, 0);
  console.log(`   ${reserveCount} reserves across ${Object.keys(aaveReserves).length} tokens`);
  
  // 2. Fetch Euler vaults
  console.log('2. Fetching Euler ETH vaults...');
  const eulerVaults = await fetchEulerVaults('eth');
  
  // 3. Create enrichment table
  db.exec(`CREATE TABLE IF NOT EXISTS position_markets (
    position_id INTEGER PRIMARY KEY REFERENCES positions(id),
    protocol TEXT,
    chain TEXT,
    market_id TEXT,
    market_name TEXT,
    underlying_token TEXT,
    source TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  
  // 4. Enrich Aave positions
  console.log('3. Enriching Aave positions...');
  const aavePositions = db.prepare(`
    SELECT p.id, p.wallet, p.chain, p.position_index,
      (SELECT json_group_array(json_object('symbol', pt.symbol, 'role', pt.role, 'address', pt.address))
       FROM position_tokens pt WHERE pt.position_id = p.id) as tokens
    FROM positions p WHERE p.protocol_name = 'Aave V3'
  `).all();
  
  const insertMarket = db.prepare(`
    INSERT OR REPLACE INTO position_markets (position_id, protocol, chain, market_id, market_name, underlying_token, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  let aaveEnriched = 0;
  db.transaction(() => {
    for (const pos of aavePositions) {
      const tokens = JSON.parse(pos.tokens || '[]');
      const supplyAddr = tokens.find(t => t.role === 'supply')?.address?.toLowerCase();
      const borrowAddr = tokens.find(t => t.role === 'borrow')?.address?.toLowerCase();
      
      // Check position_index for vToken addresses
      const posIndex = (pos.position_index || '').toLowerCase();
      let matched = null;
      
      // Search all reserves for a vToken match in position_index
      for (const [underlying, reserves] of Object.entries(aaveReserves)) {
        for (const r of reserves) {
          if (r.vToken && posIndex.includes(r.vToken.toLowerCase())) {
            matched = { ...r, underlying };
            break;
          }
        }
        if (matched) break;
      }
      
      if (matched) {
        insertMarket.run(pos.id, 'Aave V3', pos.chain, matched.vToken, matched.marketName, matched.underlying, 'vToken-in-pos-index');
        aaveEnriched++;
      } else if (supplyAddr && aaveReserves[supplyAddr]) {
        // Default to first reserve (usually Core)
        const r = aaveReserves[supplyAddr][0];
        insertMarket.run(pos.id, 'Aave V3', pos.chain, r.vToken, r.marketName + ' (default)', supplyAddr, 'first-reserve');
        aaveEnriched++;
      }
    }
  })();
  
  console.log(`   Enriched ${aaveEnriched}/${aavePositions.length} Aave positions`);
  
  // 5. Enrich Euler positions
  console.log('4. Enriching Euler positions...');
  const eulerPositions = db.prepare(`
    SELECT p.id, p.wallet, p.chain, p.position_index,
      (SELECT json_group_array(json_object('symbol', pt.symbol, 'role', pt.role, 'address', pt.address))
       FROM position_tokens pt WHERE pt.position_id = p.id) as tokens
    FROM positions p WHERE p.protocol_name = 'Euler'
  `).all();
  
  let eulerEnriched = 0;
  db.transaction(() => {
    for (const pos of eulerPositions) {
      const tokens = JSON.parse(pos.tokens || '[]');
      const supplyAddr = tokens.find(t => t.role === 'supply')?.address?.toLowerCase();
      const borrowAddr = tokens.find(t => t.role === 'borrow')?.address?.toLowerCase();
      
      // For Euler, position_index IS the proxy account
      // We need to find which vault the position is in by matching asset to vault
      // This is imperfect — multiple vaults for same asset
      
      // Check if position_index matches any vault address
      const posIdx = pos.position_index?.toLowerCase();
      if (eulerVaults[posIdx]) {
        const vault = eulerVaults[posIdx];
        insertMarket.run(pos.id, 'Euler', pos.chain, posIdx, vault.name, vault.asset, 'pos-index-is-vault');
        eulerEnriched++;
        continue;
      }
      
      // Default: use underlying address to find a vault
      // This is the best we can do without querying Euler's API per position
      const assetToCheck = supplyAddr || borrowAddr;
      if (assetToCheck) {
        // Find first vault matching this asset
        const matchingVault = Object.entries(eulerVaults).find(([addr, v]) => v.asset === assetToCheck);
        if (matchingVault) {
          insertMarket.run(pos.id, 'Euler', pos.chain, matchingVault[0], matchingVault[1].name, assetToCheck, 'asset-match');
          eulerEnriched++;
        }
      }
    }
  })();
  
  console.log(`   Enriched ${eulerEnriched}/${eulerPositions.length} Euler positions`);
  
  // 6. Show results
  console.log('\n=== Enrichment Results ===');
  const enriched = db.prepare(`
    SELECT pm.*, p.wallet, p.chain, 
      (SELECT GROUP_CONCAT(pt.symbol) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'supply') as supply_tokens,
      (SELECT GROUP_CONCAT(pt.symbol) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'borrow') as borrow_tokens
    FROM position_markets pm
    JOIN positions p ON p.id = pm.position_id
    ORDER BY pm.protocol, pm.chain, pm.market_name
  `).all();
  
  for (const r of enriched) {
    console.log(`${r.protocol.padEnd(10)} ${r.chain.padEnd(6)} ${r.market_name?.padEnd(35)} ${r.supply_tokens || '?'} / ${r.borrow_tokens || '?'}`);
    console.log(`           market_id: ${r.market_id}`);
  }
  
  db.close();
  console.log('\nDone. Market info stored in position_markets table.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
