#!/usr/bin/env node
/**
 * fix-aave-reserves.js
 * Queries Aave GraphQL API to map positions to specific reserves/markets.
 * This allows Merkl campaigns to match by reserve (e.g., Horizon USDC vs Core USDC).
 */

const Database = require('better-sqlite3');
const https = require('https');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const AAVE_API = 'https://api.v3.aave.com/graphql';

function queryAave(query, variables = {}) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(AAVE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
    });
    req.on('error', rej);
    req.write(body);
    req.end();
  });
}

async function getChainIdMap(db) {
  // Map chain name to Aave chainId
  const chains = await queryAave('query { chains { name chainId } }');
  const map = {};
  for (const c of (chains.data?.chains || [])) {
    map[c.name.toLowerCase()] = c.chainId;
  }
  console.log('Chain map:', map);
  return map;
}

async function getReservesForMarket(chainId) {
  // Get all reserves for a chain
  const query = `query Markets($request: MarketsRequest!) {
    markets(request: $request) {
      chain { name chainId }
      reserves {
        underlyingToken { address symbol name decimals }
        aTokenAddress
        variableDebtTokenAddress
        stableDebtTokenAddress
        market { name }
        borrowInfo { apy { value } }
        supplyInfo { apy { value } }
      }
    }
  }`;
  
  const result = await queryAave(query, { request: { chainId } });
  return result.data?.markets || [];
}

async function main() {
  const db = new Database(DB_PATH);
  
  // Get Aave positions
  const positions = db.prepare(`
    SELECT p.id, p.wallet, p.chain, p.position_index,
      (SELECT json_group_array(json_object('symbol', pt.symbol, 'role', pt.role, 'address', pt.address))
       FROM position_tokens pt WHERE pt.position_id = p.id) as tokens
    FROM positions p WHERE p.protocol_name = 'Aave V3'
  `).all();
  
  console.log('Aave positions:', positions.length);
  
  // For ETH positions, get all reserves
  console.log('\nFetching ETH reserves...');
  const markets = await getReservesForMarket(1);
  console.log('ETH markets:', markets.length);
  
  // Build reserve lookup: underlying address → { market, aToken, debtToken }
  const reserveMap = {};
  for (const market of markets) {
    for (const reserve of (market.reserves || [])) {
      const addr = reserve.underlyingToken?.address?.toLowerCase();
      if (addr) {
        reserveMap[addr] = {
          marketName: market.name || 'Core',
          symbol: reserve.underlyingToken?.symbol,
          aToken: reserve.aTokenAddress?.toLowerCase(),
          debtToken: reserve.variableDebtTokenAddress?.toLowerCase(),
          supplyApy: reserve.supplyInfo?.apy?.value,
          borrowApy: reserve.borrowInfo?.apy?.value,
        };
      }
    }
  }
  
  // Check specific tokens
  const usdcAddr = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  console.log('\nUSDC reserves:');
  // There might be multiple reserves for USDC (Core, Horizon, etc.)
  // Let's query specifically
  const usdcReserves = Object.entries(reserveMap)
    .filter(([addr, r]) => addr === usdcAddr || r.symbol === 'USDC');
  for (const [addr, r] of usdcReserves) {
    console.log('  ', r.symbol, r.marketName, 'supply:', r.supplyApy?.toFixed(2) + '%', 'borrow:', r.borrowApy?.toFixed(2) + '%');
    console.log('    aToken:', r.aToken);
    console.log('    debtToken:', r.debtToken);
  }
  
  // Check which reserves are Core vs Horizon
  console.log('\nAll USDC-related reserves:');
  for (const [addr, r] of Object.entries(reserveMap)) {
    if (r.symbol === 'USDC' || r.marketName?.includes('Horizon')) {
      console.log('  ', addr.slice(0, 12), r.symbol.padEnd(8), r.marketName, 'borrow:', r.borrowApy?.toFixed(2) + '%');
    }
  }
  
  db.close();
}

main().catch(console.error);
