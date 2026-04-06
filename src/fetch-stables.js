const fs = require('fs');
const path = require('path');

const DEFI_LLAMA = 'https://yields.llama.fi/pools';

const POOLS = [
  { name: 'sUSDe', pool: '66985a81-9c51-46ca-9977-42b4fe7bc6df' },
  { name: 'syrupUSDT', pool: '1f4f9153-f8ce-42f1-993e-38e391cd4428' },
  { name: 'syrupUSDC', pool: 'f22d2f92-347c-4be4-89e8-5b8735853d96' },
  { name: 'OUSG', pool: '7436db9b-2872-46c8-81a2-da6baff902b7' },
  { name: 'reUSD', pool: 'cca4dedb-569c-49ab-b053-d48d8d41dfd4' },
  { name: 'reUSDe', pool: '0cac92be-caaa-4cec-8f5a-712629a588c8' },
  { name: 'apxUSD', pool: '3673122c-2d30-4636-b5e7-57ad51508043' },
  { name: 'sUSDu', pool: '7f980c43-5b87-4690-a11a-b0e8a5e37a63' },
  { name: 'apyUSD', pool: '9941f941-9574-41af-b001-6c9465b0b5e6' },
  { name: 'srUSDe', pool: '843be062-d836-43ef-9670-c78d6ecb60bf' },
  { name: 'jrNUSD', pool: '947928b7-c446-49d7-a378-392df37660f7' },
  { name: 'sNUSD', pool: 'a064d3a0-e0b0-42c2-8992-1358c950bc6d' },
  { name: 'upUSDC', pool: '6b6ddb24-adfd-449d-a21e-e029a102e318' },
  { name: 'USD3', pool: 'f8cd444e-d99f-4132-b234-fd3482bf8806' },
  { name: 'gUSDC', pool: '766b4c34-76b3-4a57-bbec-2c972ddf8b86' },
  { name: 'fUSDT', pool: '4e8cc592-c8d5-4824-8155-128ba521e903' },
  { name: 'sUSDai', pool: '712ce948-bd9e-4f4a-8916-b72c447f7578' },
  { name: 'siUSD', pool: '8fa2e60e-365a-41fc-8d50-fadde5041f94' },
  { name: 'sUSDf', pool: '0f67a08c-3f24-4a4b-963e-541f5a5c0364' },
  { name: 'USDG', pool: '8bc218ed-faf1-41e9-a636-2989e9f7e805' },
  { name: 'ynUSDx', pool: 'bc8b5474-015a-4af5-8d88-3b4b6155b56e' },
  { name: 'WOUSD', pool: '48d4d48f-7207-48e1-8884-4852098faa80' },
  { name: 'wsrUSD', pool: 'd646f32f-d5af-4e34-a29f-8ebeea6a8520' },
  { name: 'stcUSD', pool: 'bf6ca887-e357-49ec-8031-0d1a6141c455' },
  { name: 'sUSDa', pool: '282c70ef-5123-4873-a115-a96879183e4e' },
  { name: 'sfrxUSD', pool: '42523cca-14b0-44f6-95fb-4781069520a5' },
  { name: 'fUSDC', pool: 'a20bf6f8-71af-49c6-a9d7-6f2abe5738c9' },
  { name: 'sUSDS', pool: 'd8c4eff5-c8a9-46fc-a888-057c4c668e72' },
  { name: 'sYUSD', pool: '392e2c0a-a086-46a3-841f-ca4d476eb5e1' },
  { name: 'dUSDC', pool: '20e45c3e-7de7-4d34-89e7-20858ecdf252' },
  { name: 'cUSDO', pool: 'b2ebf3c0-a173-4d61-959b-23405b7d4edb' },
  { name: 'alUSD', pool: '7565527d-6925-4e8d-8678-794999db45a5' },
  { name: 'sFRAX', pool: '55de30c3-bf9f-4d4e-9e0b-536a8ef5ab35' },
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
      console.log(`  ✅ ${target.name}: ${pool.apy.toFixed(2)}% (${pool.chain}, $${(pool.tvlUsd / 1e6).toFixed(0)}M)`);
    } else {
      console.log(`  ❌ ${target.name}: pool not found or no APY`);
    }
  }
  
  const outPath = path.join(__dirname, '..', 'data', 'stables.json');
  fs.writeFileSync(outPath, JSON.stringify({
    stables,
    fetched_at: new Date().toISOString(),
  }, null, 2));
  
  console.log(`\nSaved ${stables.length} stables to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
