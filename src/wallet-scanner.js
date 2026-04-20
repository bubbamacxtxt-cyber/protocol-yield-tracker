#!/usr/bin/env node
/**
 * wallet-scanner-v2.js
 * 
 * DeBank replacement: complete wallet position scanner.
 * 
 * Pipeline:
 * 1. alchemy_getTokenBalances → all tokens with balances
 * 2. alchemy_getTokenMetadata → symbol, decimals, name  
 * 3. eth_call to asset() → detect ERC-4626 vaults, get underlying
 * 4. Cross-reference against known protocol registries
 * 5. Get USD prices from CoinGecko/DeFiLlama
 * 6. Get APY from protocol APIs
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { fetchJSON } = require('./fetch-helper');

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

const ALCHEMY_ENDPOINTS = {
  eth: 'https://eth-mainnet.g.alchemy.com/v2/',
  base: 'https://base-mainnet.g.alchemy.com/v2/',
  arb: 'https://arb-mainnet.g.alchemy.com/v2/',
  mnt: 'https://mantle-mainnet.g.alchemy.com/v2/',
  sonic: 'https://sonic-mainnet.g.alchemy.com/v2/',
  plasma: 'https://plasma-mainnet.g.alchemy.com/v2/',
  ink: 'https://ink-mainnet.g.alchemy.com/v2/',
};

// Load known protocol tokens from DB
function loadProtocolTokens(db) {
  const tokens = {};
  try {
    // Aave aTokens
    const aaveTokens = db.prepare(`
      SELECT DISTINCT underlying, 'aave' as protocol 
      FROM position_markets WHERE market_name LIKE 'Aave%'
    `).all();
    for (const t of aaveTokens) {
      if (t.underlying) tokens[t.underlying.toLowerCase()] = { protocol: 'Aave', type: 'aToken' };
    }
  } catch {}
  
  return tokens;
}

// Alchemy API
async function alchemy(method, params, chain = 'eth') {
  const base = ALCHEMY_ENDPOINTS[chain];
  if (!base) return null;
  
  const res = await fetchJSON(`${base}${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 2);
  return res?.result;
}

// Get token balances
async function getBalances(wallet, chain) {
  const r = await alchemy('alchemy_getTokenBalances', [wallet], chain);
  return r?.tokenBalances || [];
}

// Get token metadata
async function getMetadata(address, chain) {
  return await alchemy('alchemy_getTokenMetadata', [address], chain);
}

// Check if ERC-4626 vault and get underlying
async function getUnderlying(tokenAddress, chain) {
  try {
    const r = await alchemy('eth_call', [{
      to: tokenAddress,
      data: '0x52ef1b7d', // asset() selector
    }, 'latest'], chain);
    
    if (r && r !== '0x' && r.length >= 66) {
      return '0x' + r.slice(-40);
    }
  } catch {}
  return null;
}

// Get USD prices from DeFiLlama
async function getPrices(addresses) {
  const chainAddresses = addresses.map(a => `ethereum:${a}`).join(',');
  const res = await fetchJSON(`https://coins.llama.fi/prices/current/${chainAddresses}`);
  return res?.coins || {};
}

/**
 * Main scanner - replaces DeBank position scanning
 */
async function scanWalletFull(wallet, chains = ['eth', 'base', 'arb']) {
  const results = { tokens: [], vaults: [], totalUsd: 0 };
  
  for (const chain of chains) {
    // 1. Get all token balances
    const balances = await getBalances(wallet, chain);
    if (!balances.length) continue;
    
    for (const bal of balances) {
      const hex = bal.tokenBalance;
      if (!hex || hex === '0x0' || hex === '0x00') continue;
      
      const amount = BigInt(hex);
      if (amount <= 0n) continue;
      
      // 2. Get metadata
      const meta = await getMetadata(bal.contractAddress, chain);
      if (!meta) continue;
      
      const decimals = meta.decimals || 18;
      const rawAmount = Number(amount) / (10 ** decimals);
      
      // 3. Check if ERC-4626 vault
      const underlying = await getUnderlying(bal.contractAddress, chain);
      
      const token = {
        address: bal.contractAddress.toLowerCase(),
        chain,
        symbol: meta.symbol || '?',
        name: meta.name || '',
        amount: rawAmount,
        isVault: underlying !== null,
        underlying: underlying?.toLowerCase() || null,
        usd: 0,
        protocol: null,
      };
      
      results.tokens.push(token);
    }
  }
  
  // 4. Get USD prices for all unique addresses
  const uniqueAddresses = [...new Set(results.tokens.map(t => t.address))];
  console.log(`  Getting prices for ${uniqueAddresses.length} tokens...`);
  
  // Batch in groups of 100
  for (let i = 0; i < uniqueAddresses.length; i += 100) {
    const batch = uniqueAddresses.slice(i, i + 100);
    const prices = await getPrices(batch);
    
    for (const token of results.tokens) {
      const key = `ethereum:${token.address}`;
      if (prices[key]) {
        token.usd = token.amount * prices[key].price;
      }
    }
  }
  
  // 5. Identify vaults and their protocols
  for (const token of results.tokens) {
    if (token.isVault) {
      results.vaults.push(token);
    }
  }
  
  results.totalUsd = results.tokens.reduce((sum, t) => sum + t.usd, 0);
  return results;
}

// CLI
if (require.main === module) {
  const wallet = process.argv[2] || '0x815f5BB257e88b67216a344C7C83a3eA4EE74748';
  
  async function main() {
    console.log(`=== Wallet Scanner v2 (Alchemy) ===`);
    console.log(`Wallet: ${wallet}\n`);
    
    const result = await scanWalletFull(wallet, ['eth']);
    
    // Show valuable tokens (> $1)
    const valuable = result.tokens.filter(t => t.usd > 1).sort((a, b) => b.usd - a.usd);
    
    console.log(`\nValuable tokens (${valuable.length}):`);
    for (const t of valuable) {
      const vault = t.isVault ? ` [VAULT]` : '';
      console.log(`  ${t.symbol}: $${t.usd.toFixed(2)}${vault}`);
    }
    
    console.log(`\nVaults detected: ${result.vaults.length}`);
    for (const v of result.vaults) {
      console.log(`  ${v.symbol} → ${v.underlying}`);
    }
    
    console.log(`\nTotal: $${result.totalUsd.toFixed(2)}`);
  }
  
  main().catch(console.error);
}

module.exports = { scanWalletFull, getBalances, getMetadata, getUnderlying };
