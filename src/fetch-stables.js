const fs = require('fs');
const path = require('path');

// DeFiLlama yields API (free, no auth)
const DEFI_LLAMA = 'https://yields.llama.fi/pools';

// Yield-bearing stablecoins to track
// Pool IDs from DeFiLlama (highest TVL pools)
const POOLS = [
  { name: 'sUSDe',    pool: '66985a81-9c51-46ca-9977-42b4fe7bc6df' },
  { name: 'syrupUSDT', pool: '1f4f9153-f8ce-42f1-993e-38e391cd4428' },
  { name: 'syrupUSDC', pool: 'f22d2f92-347c-4be4-89e8-5b8735853d96' },
  { name: 'OUSG',    pool: '7436db9b-2872-46c8-81a2-da6baff902b7' },
];

async function main() {
  console.log('Fetching DeFiLlama yields...');
  
  const res = await fetch(DEFI_LLAMA);
  if (!res.ok) throw new Error(`DeFiLlama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const pools = data.data || data;
  
  const stables = [];
  
  for (const target of POOLS) {
    const pool = pools.find(p => p.pool === target.pool);
    if (pool && pool.apy != null) {
      stables.push({
        name: target.name,
        apr: pool.apy.toFixed(2) + '%',
        aprValue: pool.apy,
        chain: pool.chain || 'N/A',
        tvl: pool.tvlUsd ? '$' + (pool.tvlUsd / 1e6).toFixed(0) + 'M' : 'N/A',
      });
      console.log(`  ✅ ${target.name}: ${pool.apy.toFixed(2)}% (${pool.chain}, ${(pool.tvlUsd / 1e6).toFixed(0)}M TVL)`);
    } else {
      console.log(`  ❌ ${target.name}: pool not found or no APY`);
    }
  }
  
  // Save to data/stables.json
  const outPath = path.join(__dirname, '..', 'data', 'stables.json');
  fs.writeFileSync(outPath, JSON.stringify({
    stables,
    fetched_at: new Date().toISOString(),
  }, null, 2));
  
  console.log(`\nSaved ${stables.length} stables to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
