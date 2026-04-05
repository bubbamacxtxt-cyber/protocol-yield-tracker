const PORTALS_API = 'https://api.portals.fi/v2/tokens';
const PORTALS_KEY = process.env.PORTALS_API_KEY || 'e9302cf2-58c8-4275-a533-ed0342b78fff';
const fs = require('fs');
const path = require('path');

// Yield-bearing stablecoins to track
const TOKENS = [
  { symbol: 'sUSDe',    search: 'SUSDE' },
  { symbol: 'syrupUSDT', search: 'syrupUSDT' },
  { symbol: 'syrupUSDC', search: 'syrupUSDC' },
  { symbol: 'OUSG',    search: 'OUSG' },
  { symbol: 'eUSDC',   search: 'eUSDC' },
];

async function fetchPortals(search) {
  const url = `${PORTALS_API}?search=${encodeURIComponent(search)}&limit=20`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${PORTALS_KEY}` }
  });
  if (!res.ok) throw new Error(`Portals ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const stables = [];
  
  for (const token of TOKENS) {
    try {
      const data = await fetchPortals(token.search);
      const results = data.results || data.tokens || [];
      
      // Find exact symbol match with highest TVL
      const candidates = results.filter(t => {
        const sym = t.symbol?.toUpperCase();
        const apy = t.metrics?.apy;
        // Match exact symbol or LP variants (e.g. SUSDE, not DAI/SUSDE)
        return (sym === token.symbol.toUpperCase() || sym === token.search.toUpperCase()) 
               && apy && apy !== '0' && apy !== 'null';
      });
      
      if (candidates.length > 0) {
        // Pick one with highest TVL
        const match = candidates.sort((a, b) => 
          parseFloat(b.totalSupply || 0) - parseFloat(a.totalSupply || 0)
        )[0];
        
        const apy = match.metrics.apy;
        stables.push({
          name: token.symbol,
          apr: parseFloat(apy).toFixed(2) + '%',
          aprValue: parseFloat(apy),
          chain: (match.network || '').charAt(0).toUpperCase() + (match.network || '').slice(1),
          tvl: match.totalSupply || 'N/A',
        });
        console.log(`  ✅ ${token.symbol}: ${apy}% (${match.platform}, ${match.network}, TVL: ${match.totalSupply})`);
      } else {
        console.log(`  ❌ ${token.symbol}: no match (${results.length} results)`);
        // Debug: show top results
        for (const r of results.slice(0, 3)) {
          console.log(`     - ${r.symbol} ${r.platform} ${r.network} apy=${r.metrics?.apy} tvl=${r.totalSupply}`);
        }
      }
    } catch (e) {
      console.error(`  ❌ ${token.symbol}: ${e.message}`);
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
