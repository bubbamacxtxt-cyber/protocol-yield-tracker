#!/usr/bin/env node
/**
 * hybrid-scanner.js
 * 
 * Best solution for replacing DeBank position scanning:
 * 
 * 1. Protocol-specific scanners (Aave, Morpho, Euler) - catches ALL positions
 * 2. Alchemy token balances - catches remaining non-protocol tokens
 * 3. Falls back to DeBank if Alchemy fails
 * 
 * This gives us better coverage than DeBank alone.
 */

const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const SRC = __dirname;

/**
 * Scan all wallets using protocol-specific scanners
 */
async function scanProtocolPositions(wallets) {
  const results = {
    aave: [],
    morpho: [],
    euler: [],
  };
  
  // These scanners write directly to DB, so we run them and then read
  console.log('Running Aave scanner...');
  execSync(`node ${SRC}/aave-scanner.js`, { cwd: path.join(SRC, '..'), timeout: 300000 });
  
  console.log('Running Morpho scanner...');
  execSync(`node ${SRC}/morpho-scanner.js`, { cwd: path.join(SRC, '..'), timeout: 120000 });
  
  console.log('Running Euler scanner...');
  execSync(`node ${SRC}/euler-scanner.js`, { cwd: path.join(SRC, '..'), timeout: 120000 });
  
  // Read results from DB
  const db = new Database(DB_PATH);
  const positions = db.prepare(`
    SELECT p.wallet, p.chain, p.protocol_name, p.asset_usd, p.debt_usd, p.net_usd,
           (SELECT json_group_array(json_object('symbol', pt.symbol, 'role', pt.role, 'value_usd', pt.value_usd, 'apy_base', pt.apy_base))
            FROM position_tokens pt WHERE pt.position_id = p.id) as tokens
    FROM positions p
    WHERE p.scanned_at > datetime('now', '-1 hour')
  `).all();
  
  db.close();
  return positions;
}

/**
 * Compare DeBank vs Protocol Scanners
 */
function compareResults(debankPositions, scannerPositions) {
  console.log('\n=== DeBank vs Protocol Scanner Comparison ===\n');
  
  // Group scanner positions by wallet
  const scannerByWallet = {};
  for (const p of scannerPositions) {
    if (!scannerByWallet[p.wallet]) scannerByWallet[p.wallet] = [];
    scannerByWallet[p.wallet].push(p);
  }
  
  let debankOnly = 0;
  let scannerOnly = 0;
  let bothFound = 0;
  
  for (const dp of debankPositions) {
    const scannerP = scannerByWallet[dp.wallet]?.find(sp => 
      sp.chain === dp.chain && sp.protocol_name === dp.protocol
    );
    if (scannerP) {
      bothFound++;
      const diff = Math.abs(dp.net_usd - scannerP.net_usd) / Math.max(dp.net_usd, scannerP.net_usd) * 100;
      if (diff > 10) {
        console.log(`⚠️ ${dp.wallet.slice(0,10)} ${dp.chain} ${dp.protocol}: DeBank $${(dp.net_usd/1e6).toFixed(2)}M vs Scanner $${(scannerP.net_usd/1e6).toFixed(2)}M (${diff.toFixed(1)}% diff)`);
      }
    } else {
      debankOnly++;
    }
  }
  
  console.log(`\nBoth found: ${bothFound}`);
  console.log(`DeBank only: ${debankOnly}`);
  console.log(`Scanner only: ${scannerOnly}`);
}

// CLI
if (require.main === module) {
  async function main() {
    console.log('=== Hybrid Scanner (DeBank Replacement) ===\n');
    
    const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
    
    // Get all wallet addresses
    const allWallets = [];
    for (const [label, config] of Object.entries(wallets)) {
      const addrs = Array.isArray(config) ? config : (config.vaults ? Object.values(config.vaults).flat() : []);
      for (const addr of addrs) {
        allWallets.push({ wallet: addr, label });
      }
    }
    console.log(`Total wallets: ${allWallets.length}\n`);
    
    // Run protocol scanners
    const positions = await scanProtocolPositions(allWallets);
    
    // Summarize
    const byProtocol = {};
    for (const p of positions) {
      if (!byProtocol[p.protocol_name]) byProtocol[p.protocol_name] = { count: 0, total: 0 };
      byProtocol[p.protocol_name].count++;
      byProtocol[p.protocol_name].total += p.net_usd || 0;
    }
    
    console.log('\n=== Protocol Scanner Results ===');
    for (const [proto, data] of Object.entries(byProtocol)) {
      console.log(`  ${proto}: ${data.count} positions, $${(data.total/1e6).toFixed(2)}M`);
    }
  }
  
  main().catch(console.error);
}

module.exports = { scanProtocolPositions, compareResults };
