#!/usr/bin/env node
/**
 * Aave v3 Position Scanner
 * 
 * Uses Aave's GraphQL API for position discovery
 * - userSupplies: get all supplied assets
 * - userBorrows: get all borrowed assets
 * - userMarketState: get aggregate state (health factor, net worth, APY)
 * 
 * Also fetches Merkl reward APRs via Merit API
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const DB_PATH = require('path').join(__dirname, '..', 'yield-tracker.db');

const AAVE_GRAPHQL = 'https://api.v3.aave.com/graphql';
const MERIT_API = 'https://apps.aavechan.com/api/merit/aprs';

// Known market addresses per chain
const MARKETS = {
  1: [ // Ethereum
    '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // AaveV3Ethereum
    '0x0AA97c284e98396202b6A04024F5E2c65026F3c0', // AaveV3EthereumEtherFi
    '0x4e033931ad43597d96D6bcc25c280717730B58B1', // AaveV3EthereumLido
    '0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8', // AaveV3EthereumHorizon
  ],
  8453: [ // Base
    '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  ],
  42161: [ // Arbitrum
    '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  ],
  137: [ // Polygon
    '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  ],
};

// ============================================
// Fetch user supplies for a market
// ============================================
async function getUserSupplies(userAddress, chainId) {
  const markets = MARKETS[chainId] || MARKETS[1];
  const marketInputs = markets.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ userSupplies(request: { user: "${userAddress}", markets: [${marketInputs}] }) { market { name address } currency { symbol address decimals } balance { amount { value } usd } apy { value } isCollateral } }`
    })
  });
  const data = await res.json();
  return data?.data?.userSupplies || [];
}

// ============================================
// Fetch user borrows for a market
// ============================================
async function getUserBorrows(userAddress, chainId) {
  const markets = MARKETS[chainId] || MARKETS[1];
  const marketInputs = markets.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ userBorrows(request: { user: "${userAddress}", markets: [${marketInputs}] }) { market { name address } currency { symbol address decimals } debt { amount { value } usd } apy { value } } }`
    })
  });
  const data = await res.json();
  return data?.data?.userBorrows || [];
}

// ============================================
// Fetch user market state (health factor, etc.)
// ============================================
async function getUserMarketState(userAddress, marketAddress, chainId) {
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ userMarketState(request: { user: "${userAddress}", market: "${marketAddress}", chainId: ${chainId} }) { netWorth healthFactor totalCollateralBase totalDebtBase availableBorrowsBase userEarnedAPY { value } userDebtAPY { value } netAPY { value } } }`
    })
  });
  const data = await res.json();
  return data?.data?.userMarketState || null;
}

// ============================================
// Fetch Merkl reward APRs
// ============================================
async function getMeritAPRs(userAddress) {
  try {
    const res = await fetch(`${MERIT_API}?user=${userAddress}`);
    const data = await res.json();
    return data?.currentAPR?.actionsAPR || {};
  } catch {
    return {};
  }
}

// ============================================
// Scan wallet
// ============================================
async function scanWallet(wallet, label, db) {
  console.log(`\n--- ${label} (${wallet.slice(0,12)}) ---`);
  
  const allPositions = [];
  
  // Scan mainnet first
  const chainId = 1;
  
  // Get supplies and borrows
  const [supplies, borrows, state] = await Promise.all([
    getUserSupplies(wallet, chainId),
    getUserBorrows(wallet, chainId),
    getUserMarketState(wallet, MARKETS[1][0], chainId),
  ]);
  
  // Get Merkl rewards
  const meritAPRs = await getMeritAPRs(wallet);
  
  console.log(`  Supply positions: ${supplies.length}`);
  console.log(`  Borrow positions: ${borrows.length}`);
  
  // Process supplies
  for (const s of supplies) {
    const pos = {
      wallet, label,
      protocol_name: 'Aave v3',
      protocol_id: 'aave-v3',
      symbol: s.currency?.symbol || '?',
      token_address: s.currency?.address,
      market_address: s.market?.address,
      amount: parseFloat(s.balance?.amount?.value || 0),
      value_usd: parseFloat(s.balance?.usd || 0),
      apy_base: parseFloat(s.apy?.value || 0) * 100,
      apy_bonus: null,
      chain: chainId,
      type: 'supply',
      is_collateral: s.isCollateral || false,
    };
    
    // Check for Merkl rewards
    const marketName = s.market?.name || '';
    const meritKey = `ethereum-supply-${s.currency?.symbol?.toLowerCase()}`;
    if (meritAPRs[meritKey]) {
      pos.apy_bonus = meritAPRs[meritKey];
    }
    
    if (pos.value_usd > 0.01) {
      console.log(`    ✅ ${pos.symbol}: $${pos.value_usd.toFixed(2)} | APY: ${pos.apy_base.toFixed(2)}%${pos.apy_bonus ? ' + ' + pos.apy_bonus.toFixed(2) + '%' : ''}`);
      allPositions.push(pos);
    }
  }
  
  // Process borrows
  for (const b of borrows) {
    const pos = {
      wallet, label,
      protocol_name: 'Aave v3',
      protocol_id: 'aave-v3',
      symbol: b.currency?.symbol || '?',
      token_address: b.currency?.address,
      market_address: b.market?.address,
      amount: parseFloat(b.debt?.amount?.value || 0),
      value_usd: parseFloat(b.debt?.usd || 0),
      apy_borrow: parseFloat(b.apy?.value || 0) * 100,
      chain: chainId,
      type: 'borrow',
    };
    
    if (pos.value_usd > 0.01) {
      console.log(`    📊 ${pos.symbol}: $${pos.value_usd.toFixed(2)} borrow | APY: ${pos.apy_borrow.toFixed(2)}%`);
      allPositions.push(pos);
    }
  }
  
  // Show aggregate state
  if (state) {
    console.log(`  Health Factor: ${state.healthFactor ? parseFloat(state.healthFactor).toFixed(3) : 'N/A'}`);
    console.log(`  Net Worth: $${parseFloat(state.netWorth || 0).toFixed(2)}`);
    console.log(`  Net APY: ${parseFloat(state.netAPY?.value || 0) * 100}%`);
  }
  
  return allPositions;
}

// ============================================
// Save to database
// ============================================
function savePositions(db, allPositions) {
  const insertPos = db.prepare(`INSERT OR IGNORE INTO positions (wallet, chain, protocol_id, protocol_name, position_type, net_usd, position_index, scanned_at) VALUES (?, ?, 'aave-v3', 'Aave v3', ?, ?, ?, datetime('now'))`);
  const updatePos = db.prepare(`UPDATE positions SET net_usd = ?, scanned_at = datetime('now') WHERE wallet = ? AND chain = ? AND protocol_id = 'aave-v3' AND position_index = ?`);
  const findPos = db.prepare(`SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = 'aave-v3' AND position_index = ?`);
  const insertToken = db.prepare(`INSERT INTO position_tokens (position_id, role, symbol, address, amount, apy_base, bonus_supply_apy) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const findToken = db.prepare(`SELECT id FROM position_tokens WHERE position_id = ? AND address = ?`);
  const updateToken = db.prepare(`UPDATE position_tokens SET amount = ?, apy_base = ?, bonus_supply_apy = ? WHERE id = ?`);
  
  const transaction = db.transaction(() => {
    for (const pos of allPositions) {
      const posIndex = pos.token_address;
      const netUsd = pos.value_usd || 0;
      
      insertPos.run(pos.wallet, pos.chain, pos.type, netUsd || 0, String(posIndex));
      updatePos.run(netUsd || 0, pos.wallet, pos.chain, String(posIndex));
      
      const posRow = findPos.get(pos.wallet, pos.chain, String(posIndex));
      if (!posRow) continue;
      
      const addr = pos.type === 'supply' ? pos.token_address : 'market_' + pos.token_address;
      const existing = findToken.get(posRow.id, addr);
      if (existing) {
        updateToken.run(pos.amount || 0, pos.apy_base || null, pos.apy_bonus || null, existing.id);
      } else {
        insertToken.run(posRow.id, pos.type, pos.symbol, addr, pos.amount || 0, pos.apy_base || null, pos.apy_bonus || null);
      }
    }
  });
  
  transaction();
}

// ============================================
// CLI
// ============================================
async function main() {
  const wallets = [
    { addr: '0x31eae643b679a84b37e3d0b4bd4f5da90fb04a61', label: 'Reservoir-1' },
    { addr: '0x99a95a9e38e927486fc878f41ff8b118eb632b10', label: 'Reservoir-3' },
    { addr: '0x289c204b35859bfb924b9c0759a4fe80f610671c', label: 'Reservoir-2' },
    { addr: '0x3063c5907faa10c01b242181aa689beb23d2bd65', label: 'Euler-Wallet' },
    { addr: '0x41a9eb398518d2487301c61d2b33e4e966a9f1dd', label: 'Reservoir-4' },
    { addr: '0x502d222e8e4daef69032f55f0c1a999effd78fb3', label: 'Reservoir-5' },
    { addr: '0x815f5bb257e88b67216a344c7c83a3ea4ee74748', label: 'Test-Wallet' },
  ];
  
  const db = new Database(DB_PATH);
  const allPositions = [];
  
  console.log('=== Aave v3 Scanner ===\n');
  
  for (const w of wallets) {
    const positions = await scanWallet(w.addr, w.label, db);
    allPositions.push(...positions);
  }
  
  savePositions(db, allPositions);
  
  console.log(`\n=== Summary ===`);
  console.log(`Total positions: ${allPositions.length}`);
  
  db.close();
}

module.exports = { getUserSupplies, getUserBorrows, getUserMarketState, scanWallet };

if (require.main === module) {
  main().catch(console.error);
}
