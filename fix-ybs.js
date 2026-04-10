const fs = require('fs');
const data = require('./data/stables.json');

(async () => {
  const res = await fetch('https://yields.llama.fi/pools');
  const dl = await res.json();
  const pools = dl.data;
  
  // Fix apyUSD
  const apyPool = pools.find(p => p.pool === '9941f941-9574-41af-b001-6c9465b0b5e6');
  if (apyPool) {
    const apy = data.stables.find(s => s.name === 'apyUSD');
    apy.apr = apyPool.apy.toFixed(2) + '%';
    apy.aprValue = parseFloat(apyPool.apy.toFixed(2));
    apy.tvl = apyPool.tvlUsd >= 1e6 ? '$' + (apyPool.tvlUsd/1e6).toFixed(0) + 'M' : '$' + (apyPool.tvlUsd/1e3).toFixed(0) + 'K';
    apy.tvlNum = apyPool.tvlUsd;
    apy.chain = apyPool.chain;
    console.log('Fixed apyUSD:', apy.apr, 'TVL=' + apy.tvl, 'Chain=' + apy.chain);
  }
  
  // Remove stale entries that have no valid DeFiLlama pool
  const stale = ['fUSDT', 'dUSDC'];
  stale.forEach(name => {
    const idx = data.stables.findIndex(s => s.name === name);
    if (idx >= 0) {
      data.stables.splice(idx, 1);
      console.log('Removed stale:', name);
    }
  });
  
  fs.writeFileSync('./data/stables.json', JSON.stringify(data, null, 2));
  console.log('Saved', data.stables.length, 'entries to data/stables.json');
})();
