#!/usr/bin/env node
/**
 * Euler v2 Scanner - Reservoir Only
 * 
 * Direct Euler subgraph queries - NO DeBank dependency for position data.
 * Creates positions directly from Euler API data.
 * 
 * Flow:
 * 1. For each Reservoir wallet, query Euler subgraph for vault positions
 * 2. Create positions directly from Euler data
 * 3. Include vault info, shares, underlying APY
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

// Euler subgraph URLs per chain
const EULER_SUBGRAPHS = {
  eth:    'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn',
  base:   'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-base/latest/gn',
  arb:    'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-arbitrum/latest/gn',
  sonic:  'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-sonic/latest/gn',
};

// Known vault addresses for quick lookup
const VAULT_SYMBOLS = {
  '0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2': 'eRLUSD',
  '0xba98fc35c9dfd69178ad5dce9fa29c64554783b5': 'ePYUSD',
};

async function querySubgraph(url, query) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  return data?.data || {};
}

async function getVaultInfo(url, vaultAddress) {
  const query = `{ 
    eulerVault(id: "${vaultAddress.toLowerCase()}") { 
      id name symbol asset { id symbol decimals }
    } 
  }`;
  const data = await querySubgraph(url, query);
  return data?.eulerVault || null;
}

async function getTrackingBalances(wallet) {
  // Use the tracking vault balances endpoint from subgraph
  const url = EULER_SUBGRAPHS.eth;
  const query = `{
    trackingVaultBalances(
      where: { account: "${wallet.toLowerCase()}" }
    ) {
      vault { id }
      balance
      debt
    }
  }`;
  const data = await querySubgraph(url, query);
  return data?.trackingVaultBalances || [];
}

// Simpler approach: use DeFiLlama for APY + known vaults, query subgraph for balances
async function getEulerPositionsFromSubgraph(wallet, chain, url) {
  // Try to get balances from tracking vaults
  const query = `{
    trackingVaultBalances(
      where: { account: "${wallet.toLowerCase()}" }
    ) {
      vault { id }
      balance
      debt
    }
  }`;
  
  try {
    const data = await querySubgraph(url, query);
    return data?.trackingVaultBalances || [];
  } catch {
    return [];
  }
}

function decodeShares(shareHex) {
  // Convert hex shares to number (simplified - assumes < 1e18)
  try {
    const hex = shareHex.replace('0x', '').replace(/^(00)+/, '');
    if (!hex) return 0;
    return BigInt('0x' + hex);
  } catch {
    return 0n;
  }
}

async function scanWallet(db, wallet, label) {
  console.log(`\n--- ${label} (${wallet.slice(0,12)}) ---`);
  let totalPositions = 0;
  
  // DeBank-only for Euler chain discovery, then use subgraph
  // For now, just scan mainnet where we know Reservoir has positions
  const balances = await getTrackingBalances(wallet);
  
  if (balances.length === 0) {
    console.log('  No Euler positions');
    return 0;
  }
  
  // Group by vault, sum balances
  const vaultBalances = {};
  for (const b of balances) {
    const vaultAddr = b.vault?.id?.toLowerCase();
    if (!vaultAddr) continue;
    if (!vaultBalances[vaultAddr]) vaultBalances[vaultAddr] = { shares: 0n, debt: 0n };
    vaultBalances[vaultAddr].shares += decodeShares(b.balance || '0x0');
    vaultBalances[vaultAddr].debt += decodeShares(b.debt || '0x0');
  }
  
  for (const [vaultAddr, bal] of Object.entries(vaultBalances)) {
    if (bal.shares === 0n) continue;
    
    // Get vault info
    const vaultInfo = await getVaultInfo(EULER_SUBGRAPHS.eth, vaultAddr);
    const symbol = vaultInfo?.symbol || VAULT_SYMBOLS[vaultAddr] || `e${vaultAddr.slice(0,6)}`;
    
    console.log(`  ${symbol}: ${(Number(bal.shares) / 1e18).toFixed(2)} shares`);
    totalPositions++;
  }
  
  return totalPositions;
}

async function main() {
  const db = new Database(DB_PATH);
  
  // Reservoir wallets
  const reservoir = [
    { addr: '0x31eae643b679a84b37e3d0b4bd4f5da90fb04a61', label: 'Reservoir-1' },
    { addr: '0x99a95a9e38e927486fc878f41ff8b118eb632b10', label: 'Reservoir-3' },
    { addr: '0x3063c5907faa10c01b242181aa689beb23d2bd65', label: 'Euler-Wallet' },
    { addr: '0x289c204b35859bfb924b9c0759a4fe80f610671c', label: 'Reservoir-2' },
    { addr: '0x41a9eb398518d2487301c61d2b33e4e966a9f1dd', label: 'Reservoir-4' },
  ];
  
  console.log('=== Euler v2 Scanner (Reservoir Only) ===');
  console.log(`Scanning ${reservoir.length} wallets`);
  
  let totalFound = 0;
  for (const w of reservoir) {
    const found = await scanWallet(db, w.addr, w.label);
    totalFound += found;
  }
  
  console.log(`\n=== Done: ${totalFound} positions found ===`);
  db.close();
}

main().catch(console.error);
