#!/usr/bin/env node
/**
 * Aave v3 Position Scanner (Enrich Only)
 * 
 * Enriches existing DeBank positions with APY data from Aave GraphQL.
 * Does NOT create new positions - that's DeBank's job.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const DB_PATH = require('path').join(__dirname, '..', 'yield-tracker.db');

const AAVE_GRAPHQL = 'https://api.v3.aave.com/graphql';
const MERIT_API = 'https://apps.aavechan.com/api/merit/aprs';

const MARKETS = {
  1: [
    '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    '0x0AA97c284e98396202b6A04024F5E2c65026F3c0',
    '0x4e033931ad43597d96D6bcc25c280717730B58B1',
    '0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8',
  ],
  8453: ['0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'],
  42161: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'],
  137: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'],
};

async function getUserSupplies(userAddress, chainId) {
  const markets = MARKETS[chainId] || MARKETS[1];
  const marketInputs = markets.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ userSupplies(request: { user: "${userAddress}", markets: [${marketInputs}] }) { currency { symbol } balance { usd } apy { value } isCollateral } }`
    })
  });
  const data = await res.json();
  return data?.data?.userSupplies || [];
}

async function getUserBorrows(userAddress, chainId) {
  const markets = MARKETS[chainId] || MARKETS[1];
  const marketInputs = markets.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ userBorrows(request: { user: "${userAddress}", markets: [${marketInputs}] }) { currency { symbol } debt { usd } apy { value } } }`
    })
  });
  const data = await res.json();
  return data?.data?.userBorrows || [];
}

async function getUserMarketState(userAddress, marketAddress, chainId) {
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ userMarketState(request: { user: "${userAddress}", market: "${marketAddress}", chainId: ${chainId} }) { netWorth healthFactor totalCollateralBase totalDebtBase netAPY { value } } }`
    })
  });
  const data = await res.json();
  return data?.data?.userMarketState || null;
}

async function getMeritAPRs(userAddress) {
  try {
    const res = await fetch(`${MERIT_API}?user=${userAddress}`);
    const data = await res.json();
    return data?.currentAPR?.actionsAPR || {};
  } catch { return {}; }
}

async function scanWallet(wallet, label, db) {
  console.log(`\n--- ${label} (${wallet.slice(0,12)}) ---`);
  
  const chainId = 1;
  const [supplies, borrows, meritAPRs] = await Promise.all([
    getUserSupplies(wallet, chainId),
    getUserBorrows(wallet, chainId),
    getMeritAPRs(wallet),
  ]);
  
  console.log(`  Supply: ${supplies.length}, Borrow: ${borrows.length}`);
  let enriched = 0;
  
  const findSupply = db.prepare(`SELECT p.id, pt.id as token_id FROM positions p JOIN position_tokens pt ON pt.position_id = p.id WHERE p.wallet = ? AND p.protocol_name = 'Aave v3' AND pt.symbol = ? AND pt.role = 'supply'`);
  const findBorrow = db.prepare(`SELECT p.id, pt.id as token_id FROM positions p JOIN position_tokens pt ON pt.position_id = p.id WHERE p.wallet = ? AND p.protocol_name = 'Aave v3' AND pt.symbol = ? AND pt.role = 'borrow'`);
  const updateToken = db.prepare(`UPDATE position_tokens SET apy_base = ?, bonus_supply_apy = ?, value_usd = ? WHERE id = ?`);
  const updateNet = db.prepare(`UPDATE positions SET net_usd = ?, scanned_at = datetime('now') WHERE id = ?`);
  
  const transaction = db.transaction(() => {
    for (const s of supplies) {
      const symbol = s.currency?.symbol;
      if (!symbol) continue;
      const apyBase = parseFloat(s.apy?.value || 0) * 100;
      const meritKey = `ethereum-supply-${symbol.toLowerCase()}`;
      const bonus = meritAPRs[meritKey] || null;
      
      const pos = findSupply.get(wallet, symbol);
      if (pos) {
        updateToken.run(apyBase, bonus, parseFloat(s.balance?.usd || 0), pos.token_id);
        updateNet.run(parseFloat(s.balance?.usd || 0), pos.id);
        enriched++;
      }
    }
    
    for (const b of borrows) {
      const symbol = b.currency?.symbol;
      if (!symbol) continue;
      const apyBorrow = parseFloat(b.apy?.value || 0) * 100;
      
      const pos = findBorrow.get(wallet, symbol);
      if (pos) {
        updateToken.run(apyBorrow, null, parseFloat(b.debt?.usd || 0), pos.token_id);
        updateNet.run(-parseFloat(b.debt?.usd || 0), pos.id);
        enriched++;
      }
    }
  });
  
  transaction();
  console.log(`  Enriched: ${enriched} positions`);
}

async function main() {
  const wallets = [
    { addr: '0x31eae643b679a84b37e3d0b4bd4f5da90fb04a61', label: 'Reservoir-1' },
    { addr: '0x99a95a9e38e927486fc878f41ff8b118eb632b10', label: 'Reservoir-3' },
    { addr: '0x289c204b35859bfb924b9c0759a4fe80f610671c', label: 'Reservoir-2' },
    { addr: '0x3063c5907faa10c01b242181aa689beb23d2bd65', label: 'Euler-Wallet' },
    { addr: '0x41a9eb398518d2487301c61d2b33e4e966a9f1dd', label: 'Reservoir-4' },
    { addr: '0x502d222e8e4daef69032f55f0c1a999effd78fb3', label: 'Reservoir-5' },
  ];
  
  const db = new Database(DB_PATH);
  console.log('=== Aave v3 Scanner (Enrich Only) ===');
  
  for (const w of wallets) {
    await scanWallet(w.addr, w.label, db);
  }
  
  db.close();
}

if (require.main === module) {
  main().catch(console.error);
}
