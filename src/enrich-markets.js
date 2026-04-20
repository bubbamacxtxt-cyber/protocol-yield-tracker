#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const GOLDSKY_BASE = "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs";
const EULER_CHAINS = {
  eth: "euler-v2-mainnet", base: "euler-v2-base", sonic: "euler-v2-sonic",
  arb: "euler-v2-arbitrum", op: "euler-v2-optimism",
  bera: "euler-v2-berachain", monad: "euler-v2-monad",
};
const AAVE_API = 'https://api.v3.aave.com/graphql';

// Wrapped token -> underlying token mapping for market lookups
const WRAPPED_TO_UNDERLYING = {
  '0xd3fd63209fa2d55b07a0f6db36c2f43900be3094': '0x738d1115b90efa71ae468f1287fc864775e23a31', // wsrUSD -> srUSD
};

const { fetchWithRetry, fetchJSON } = require('./fetch-helper');

async function postJSON(url, body) {
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res || !res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

async function httpGet(url) {
  return await fetchJSON(url);
}

const AAVE_CHAINS = {
  eth: 1, base: 8453, arb: 42161, plasma: 9745, mnt: 5000, ink: 57073, sonic: 146,
};

async function fetchAaveReserves() {
  const reserveMap = {};
  for (const [chainName, chainId] of Object.entries(AAVE_CHAINS)) {
    try {
      const data = await postJSON(AAVE_API, {
        query: `{ markets(request: {chainIds: [${chainId}]}) { name reserves { underlyingToken { symbol address } aToken { address } vToken { address } } } }`
      });
      const markets = data.data?.markets || [];
      for (const market of markets) {
        for (const r of (market.reserves || [])) {
          const addr = r.underlyingToken?.address?.toLowerCase();
          if (!addr) continue;
          if (!reserveMap[addr]) reserveMap[addr] = [];
          reserveMap[addr].push({
            chain: chainName,
            marketName: market.name,
            symbol: r.underlyingToken?.symbol,
            vToken: r.vToken?.address?.toLowerCase(),
            aToken: r.aToken?.address?.toLowerCase(),
          });
        }
      }
      const count = markets.reduce((s, m) => s + (m.reserves?.length || 0), 0);
      console.log(`  Aave ${chainName}: ${count} reserves`);
    } catch(e) {
      console.log(`  Aave ${chainName}: error ${e.message}`);
    }
  }
  return reserveMap;
}

async function fetchEulerVaults() {
  const vaultMap = {};
  for (const [chainName, subgraph] of Object.entries(EULER_CHAINS)) {
    try {
      const url = `${GOLDSKY_BASE}/${subgraph}/latest/gn`;
      const data = await postJSON(url, { query: '{ eulerVaults(first: 500) { id name symbol asset } }' });
      const vaults = data.data?.eulerVaults || [];
      for (const v of vaults) {
        vaultMap[v.id?.toLowerCase()] = {
          chain: chainName,
          name: v.name, symbol: v.symbol, asset: v.asset?.toLowerCase(),
        };
      }
      console.log(`  Euler ${chainName}: ${vaults.length} vaults`);
    } catch(e) {
      console.log(`  Euler ${chainName}: error`);
    }
  }
  console.log(`  Total Euler: ${Object.keys(vaultMap).length} vaults`);
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
        // Key by chain + address since Fluid uses same addresses across chains
        const key = chainName + ':' + v.address?.toLowerCase();
        vaultMap[key] = {
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
          // Must match chain
          if (r.chain !== pos.chain) continue;
          if (r.vToken && posIdx.includes(r.vToken.toLowerCase())) {
            matched = { ...r, underlying }; break;
          }
        }
        if (matched) break;
      }
      
      if (!matched && supplyAddr && aaveReserves[supplyAddr]) {
        // Filter reserves by chain
        const chainReserves = aaveReserves[supplyAddr].filter(r => r.chain === pos.chain);
        if (chainReserves.length > 0) {
          matched = { ...chainReserves[0], underlying: supplyAddr };
        }
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
      
      // First try: match position_index to vault address (for vault positions)
      if (posIdx) {
        const idxKey = pos.chain + ':' + posIdx;
        matchedVault = fluidVaults[idxKey];
      }
      
      // Second: try exact match (supply + borrow)
      if (!matchedVault) {
        for (const [key, v] of Object.entries(fluidVaults)) {
          if (v.chain !== pos.chain) continue;
          if (supplyAddr && v.supplyAddr === supplyAddr) {
            if (borrowAddr && v.borrowAddr === borrowAddr) {
              matchedVault = v; break;
            }
          }
        }
      }
      
      // Third: supply-only match for positions without borrow
      if (!matchedVault && !borrowAddr && supplyAddr) {
        for (const [key, v] of Object.entries(fluidVaults)) {
          if (v.chain === pos.chain && v.supplyAddr === supplyAddr) {
            matchedVault = v; break;
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
      
      if (eulerVaults[posIdx] && eulerVaults[posIdx].chain === pos.chain) {
        insertMarket.run(pos.id, 'Euler', pos.chain, posIdx, eulerVaults[posIdx].name, eulerVaults[posIdx].asset, 'vault-address');
        eulerOk++;
      } else if (supplyAddr) {
        const match = Object.entries(eulerVaults).find(([a, v]) => v.asset === supplyAddr && v.chain === pos.chain);
        if (match) {
          insertMarket.run(pos.id, 'Euler', pos.chain, match[0], match[1].name, supplyAddr, 'asset-match');
          eulerOk++;
        }
      }
    }
  })();
  console.log(`   ${eulerOk}/${eulerPos.length} enriched`);

  // Morpho - find market IDs for collateral/loan pairs
  console.log('7. Morpho positions...');
  const morphoPos = db.prepare(`SELECT p.id, p.chain,
    (SELECT json_group_array(json_object('symbol',pt.symbol,'role',pt.role,'address',pt.address))
     FROM position_tokens pt WHERE pt.position_id = p.id) as tokens
    FROM positions p WHERE p.protocol_name = 'Morpho'`).all();

  let morphoOk = 0;
  const morphoChains = [...new Set(morphoPos.map(p => p.chain))];
  const morphoMarkets = {};
  
  for (const chain of morphoChains) {
    const cidMap = { eth: 1, arb: 42161, base: 8453, mnt: 5000, plasma: 9745, sonic: 146, bsc: 56 };
    const cid = cidMap[chain.toLowerCase()];
    if (!cid) continue;
    const query = `{ markets(where: { chainId_in: [${cid}] }, first: 500) { items { marketId loanAsset { address } collateralAsset { address } state { dailyBorrowApy dailySupplyApy } } } }`;
    try {
      const res = await fetch('https://api.morpho.org/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const data = await res.json();
      const items = data?.data?.markets?.items || [];
      morphoMarkets[chain.toLowerCase()] = items
        .filter(m => {
          // Skip markets with abnormal APYs (>100% daily = broken/illiquid market)
          const dailyBorrow = (m.state?.dailyBorrowApy || 0) * 100;
          const dailySupply = (m.state?.dailySupplyApy || 0) * 100;
          if (dailyBorrow > 100 || dailySupply > 100) {
            if (dailyBorrow > 1000) console.log(`   ⚠️ Skipping broken market: ${m.collateralAsset?.symbol}->${m.loanAsset?.symbol} borrow ${dailyBorrow.toFixed(0)}%`);
            return false;
          }
          return true;
        })
        .map(m => ({
          loanAddr: m.loanAsset?.address?.toLowerCase(),
          collateralAddr: m.collateralAsset?.address?.toLowerCase(),
          marketId: m.marketId,
          dailyBorrowApy: m.state?.dailyBorrowApy || 0
        }))
      console.log('   ' + chain + ': ' + items.length + ' markets');
    } catch (e) {
      console.log('   ' + chain + ': failed - ' + e.message);
    }
  }

  db.transaction(() => {
    for (const pos of morphoPos) {
      const tokens = JSON.parse(pos.tokens || '[]');
      const supplyAddr = tokens.find(t => t.role === 'supply')?.address?.toLowerCase();
      const borrowAddr = tokens.find(t => t.role === 'borrow')?.address?.toLowerCase();
      const chain = pos.chain.toLowerCase();
      const markets = morphoMarkets[chain] || [];
      // Debug: find all matches
      // Try direct match first, then with underlying token
      const underlyingAddr = WRAPPED_TO_UNDERLYING[supplyAddr] || supplyAddr;
      const allMatches = markets.filter(m => 
        (m.collateralAddr === supplyAddr || m.collateralAddr === underlyingAddr) && 
        m.loanAddr === borrowAddr
      );
      if (allMatches.length > 0) {
        const usedUnderlying = allMatches[0].collateralAddr !== supplyAddr;
        console.log('   found', allMatches.length, 'matches:', allMatches[0].marketId.slice(0,12), 
                    usedUnderlying ? '(using underlying ' + allMatches[0].collateralAsset + ')' : '');
      }
      // Pick market with LOWEST borrow APY (most stable, avoids broken markets with inflated rates)
      const match = allMatches.sort((a, b) => 
        Math.abs(a.dailyBorrowApy || 0) - Math.abs(b.dailyBorrowApy || 0)
      )[0];
      if (match) {
        insertMarket.run(pos.id, 'Morpho', pos.chain, match.marketId, 'Morpho Market', match.collateralAddr, 'market-match');
        morphoOk++;
      } else {
        console.log('   no match for supply:', supplyAddr?.slice(0,10), 'borrow:', borrowAddr?.slice(0,10));
      }
    }
  })();
  console.log('   ' + morphoOk + '/' + morphoPos.length + ' enriched');

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
