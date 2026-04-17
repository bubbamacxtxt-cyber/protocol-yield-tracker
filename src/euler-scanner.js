/**
 * Euler Scanner v3
 * 
 * Sources:
 * - DeFiLlama: base APY (apyBase) + reward APY (apyReward) for Euler V2
 * - DeBank DB: position USD values
 * - Goldsky subgraph: vault addresses per wallet (optional, for matching)
 * 
 * DeFiLlama already annualizes apyBase and apyReward, so no conversion needed.
 */

require('dotenv').config();
const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

async function getEulerPools() {
  const pools = await httpsGet('https://yields.llama.fi/pools');
  return pools.data.filter(p => p.project === 'euler-v2' && p.chain === 'Ethereum');
}

async function main() {
  console.log('=== Euler Scanner v3 ===\n');
  
  const pools = await getEulerPools();
  
  // Show top pools with rewards
  console.log('Top Euler V2 pools by TVL:\n');
  const sorted = pools.sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0));
  
  for (const p of sorted.slice(0, 10)) {
    console.log(`${p.symbol}: base=${p.apyBase?.toFixed(2) || '?'}%, reward=${p.apyReward?.toFixed(2) || '0'}%, total=${p.apy?.toFixed(2) || '?'}%, TVL=$${(p.tvlUsd/1e6).toFixed(1)}M`);
  }
  
  // Match Reservoir positions
  // From DeBank: RLUSD $68.7M, PYUSD $45.9M
  console.log('\n\n=== Reservoir Positions ===\n');
  
  const vaultMatches = {
    'RLUSD': { valueUsd: 68733689 },
    'PYUSD': { valueUsd: 45863420 },
  };
  
  for (const [symbol, pos] of Object.entries(vaultMatches)) {
    const pool = pools.find(p => p.symbol === symbol && p.tvlUsd > 1e6);
    if (pool) {
      console.log(`${symbol}:`);
      console.log(`  Position: $${(pos.valueUsd/1e6).toFixed(2)}M`);
      console.log(`  Base APY: ${pool.apyBase?.toFixed(2)}%`);
      console.log(`  Reward APY: ${pool.apyReward?.toFixed(2) || 0}%`);
      console.log(`  Total APY: ${pool.apy?.toFixed(2)}%`);
      console.log(`  TVL: $${(pool.tvlUsd/1e6).toFixed(1)}M`);
      console.log(`  Pool ID: ${pool.pool}`);
    } else {
      console.log(`${symbol}: No matching pool found`);
    }
  }
  
  // Also show Merkl rewards separately (bonus on top)
  console.log('\n\n=== Merkl Bonus Rewards (cumulative, not annualized) ===\n');
  const wallets = ['0x3063C5907FAa10c01B242181Aa689bEb23D2BD65'];
  
  for (const w of wallets) {
    const merkl = await httpsGet(`https://api.merkl.xyz/v4/users/${w}/rewards?chainId=1`);
    if (!Array.isArray(merkl)) continue;
    
    for (const chainData of merkl) {
      if (!chainData.rewards) continue;
      for (const r of chainData.rewards) {
        const amount = Number(r.amount) / Math.pow(10, r.token.decimals);
        const value = amount * r.token.price;
        if (value > 100) {
          const reason = r.breakdowns?.[0]?.reason?.slice(0, 60) || '';
          console.log(`${r.token.symbol}: ${amount.toFixed(0)} ($${value.toFixed(0)}) - ${reason}`);
        }
      }
    }
  }
}

main().catch(console.error);
