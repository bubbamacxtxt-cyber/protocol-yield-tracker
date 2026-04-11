#!/usr/bin/env node
const Database = require('better-sqlite3');
const https = require('https');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const AAVE_API = 'https://api.v3.aave.com/graphql';

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

function httpGet(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
    }).on('error', rej);
  });
}

async function fetchAaveReserves() {
  const data = await postJSON(AAVE_API, {
    query: `{ markets(request: {chainIds: [1]}) { name reserves { underlyingToken { symbol address } aToken { address } vToken { address } } } }`
  });
  const markets = data.data?.markets || [];
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

async function fetchEulerVaults() {
  const url = 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn';
  const data = await postJSON(url, { query: '{ eulerVaults(first: 500) { id name symbol asset } }' });
  const vaults = data.data?.eulerVaults || [];
  const vaultMap = {};
  for (const v of vaults) {
    vaultMap[v.id?.toLowerCase()] = {
      name: v.name, symbol: v.symbol, asset: v.asset?.toLowerCase(),
    };
  }
  console.log(`  Euler: ${vaults.length} vaults`);
  return vaultMap;
}

const FLUID_CHAINS = { eth: 1, arb: 42161, base: 8453, plasma: 9745, mnt: 5000, bsc: 56, monad: 143, hyper: 999, ink: 57073 };

async function fetchFluidVaults() {
  const vaultMap = {};
  for (const [chainName, chainId] of Object.entries(FLUID_CHAINS)) {
    try {
      const data = await httpGet(`https://api.fluid.instadapp.io/v2/${chainId}/vaults`);
      const vaults = Array.isArray(data) ? data : [];
      for (const v of vaults) {
        vaultMap[v.address?.toLowerCase()] = {
          chain: chainName,
          address: v.address?.toLowerCase(),
          supplySymbol: v.supplyToken?.token0?.symbol,
          supplyAddr: v.supplyToken?.token0?.address?.toLowerCase(),
          borrowSymbol: v.borrowToken?.token0?.symbol,
          borrowAddr: v.borrowToken?.token0?.address?.toLowerCase(),
          name: `${v.supplyToken?.token0?.symbol || '?'} / ${v.borrowToken?.token0?.symbol || 'none'}`,
        };
      }
      console.log(`  Fluid ${chainName}: ${vaults.length} vaults`);
    } catch(e) {
      console.log(`  Fluid ${chainName}: ${e.message}`);
    }
  }
  return vaultMap;
}

async function main() {
  const db = new Database(DB_PATH);
  console.log('=== Market Enrichment ===\n');

  // Fetch data
  console.log('1. Aave ETH reserves...');
  const aaveReserves = await fetchAaveReserves();
  console.log(`   ${Object.values(aaveReserves).reduce((s,r)=>s+r.length, 0)} reserves`);

  console.log('2. Euler vaults...');
  const eulerVaults = await fetchEulerVaults();

  console.log('3. Fluid vaults...');
  const fluidVaults = await fetchFluidVaults();
  console.log(`   Total Fluid: ${Object.keys(fluidVaults).length} vaults`);

  // Create table
  db.exec(`CREATE TABLE IF NOT EXISTS position_markets (
    position_id INTEGER PRIMARY KEY REFERENCES positions(id),
    protocol TEXT, chain TEXT, market_id TEXT, market_name TEXT,
    underlying_token TEXT, source TEXT
  )`);
  const insertMarket = db.prepare(`INSERT OR REPLACE INTO position_markets 
    (position_id, protocol, chain, market_id, market_name, underlying_token, source) 
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  // Aave
  console.log('\n4. Aave positions...');
  const aavePos = db.prepare(`SELECT p.id, p.wallet, p.chain, p.position_index,
    (SELECT json_group_array(json_object('symbol',pt.symbol,'role',pt.role,'address',pt.address))
     FROM position_tokens pt WHERE pt.position_id = p.id) as tokens
    FROM positions p WHERE p.protocol_name = 'Aave V3'`).all();
  
  let aaveOk = 0;
  db.transaction(() => {
    for (const pos of aavePos) {
      const tokens = JSON.parse(pos.tokens || '[]');
      const supplyAddr = tokens.find(t => t.role === 'supply')?.address?.toLowerCase();
      const borrowAddr = tokens.find(t => t.role === 'borrow')?.address?.toLowerCase();
      const posIdx = (pos.position_index || '').toLowerCase();
      
      let matched = null;
      for (const [underlying, reserves] of Object.entries(aaveReserves)) {
        for (const r of reserves) {
          if (r.vToken && posIdx.includes(r.vToken.toLowerCase())) {
            matched = { ...r, underlying }; break;
          }
        }
        if (matched) break;
      }
      
      if (!matched && supplyAddr && aaveReserves[supplyAddr]) {
        matched = { ...aaveReserves[supplyAddr][0], underlying: supplyAddr };
      }
      
      if (matched) {
        insertMarket.run(pos.id, 'Aave V3', pos.chain, matched.vToken, matched.marketName, matched.underlying, 'reserve-match');
        aaveOk++;
      }
    }
  })();
  console.log(`   ${aaveOk}/${aavePos.length} enriched`);

  // Fluid
  console.log('5. Fluid positions...');
  const fluidPos = db.prepare(`SELECT p.id, p.wallet, p.chain, p.position_index,
    (SELECT json_group_array(json_object('symbol',pt.symbol,'role',pt.role,'address',pt.address))
     FROM position_tokens pt WHERE pt.position_id = p.id) as tokens
    FROM positions p WHERE p.protocol_name = 'Fluid'`).all();
  
  let fluidOk = 0;
  db.transaction(() => {
    for (const pos of fluidPos) {
      const tokens = JSON.parse(pos.tokens || '[]');
      const supplyAddr = tokens.find(t => t.role === 'supply')?.address?.toLowerCase();
      const borrowAddr = tokens.find(t => t.role === 'borrow')?.address?.toLowerCase();
      const posIdx = pos.position_index?.toLowerCase() || '';
      
      let matchedVault = null;
      for (const [vaultAddr, v] of Object.entries(fluidVaults)) {
        if (v.chain !== pos.chain) continue;
        if (supplyAddr && v.supplyAddr === supplyAddr) {
          if (borrowAddr && v.borrowAddr === borrowAddr) {
            matchedVault = v; break;
          } else if (!borrowAddr && !v.borrowAddr) {
            matchedVault = v;
          }
        }
      }
      
      if (matchedVault) {
        insertMarket.run(pos.id, 'Fluid', pos.chain, matchedVault.address, 'Fluid ' + matchedVault.name, supplyAddr, 'vault-match');
        fluidOk++;
      }
    }
  })();
  console.log(`   ${fluidOk}/${fluidPos.length} enriched`);

  // Euler
  console.log('6. Euler positions...');
  const eulerPos = db.prepare(`SELECT p.id, p.wallet, p.chain, p.position_index,
    (SELECT json_group_array(json_object('symbol',pt.symbol,'role',pt.role,'address',pt.address))
     FROM position_tokens pt WHERE pt.position_id = p.id) as tokens
    FROM positions p WHERE p.protocol_name = 'Euler'`).all();
  
  let eulerOk = 0;
  db.transaction(() => {
    for (const pos of eulerPos) {
      const tokens = JSON.parse(pos.tokens || '[]');
      const supplyAddr = tokens.find(t => t.role === 'supply')?.address?.toLowerCase();
      const borrowAddr = tokens.find(t => t.role === 'borrow')?.address?.toLowerCase();
      const posIdx = pos.position_index?.toLowerCase();
      
      if (eulerVaults[posIdx]) {
        insertMarket.run(pos.id, 'Euler', pos.chain, posIdx, eulerVaults[posIdx].name, eulerVaults[posIdx].asset, 'vault-address');
        eulerOk++;
      } else if (supplyAddr) {
        const match = Object.entries(eulerVaults).find(([a, v]) => v.asset === supplyAddr);
        if (match) {
          insertMarket.run(pos.id, 'Euler', pos.chain, match[0], match[1].name, supplyAddr, 'asset-match');
          eulerOk++;
        }
      }
    }
  })();
  console.log(`   ${eulerOk}/${eulerPos.length} enriched`);

  // Summary
  console.log('\n=== All Enriched ===');
  const all = db.prepare(`SELECT pm.*, p.protocol_name FROM position_markets pm JOIN positions p ON p.id = pm.position_id ORDER BY pm.protocol, pm.chain`).all();
  for (const r of all) {
    console.log(`${r.protocol_name.padEnd(12)} ${r.chain.padEnd(8)} ${r.market_name?.padEnd(40)} id:${r.market_id?.slice(0,12)}`);
  }
  console.log(`\nTotal: ${all.length} positions enriched`);
  
  db.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
