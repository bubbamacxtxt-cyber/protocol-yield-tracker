require('dotenv').config();
const https = require('https');
const { execSync } = require('child_process');

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
const SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-simple-mainnet/latest/gn';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function alchemyCall(to, callData) {
  const body = JSON.stringify({jsonrpc:'2.0',method:'eth_call',params:[{to,data:callData},'latest'],id:1});
  const result = execSync(`curl -s 'https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}' -H 'Content-Type: application/json' --data-raw '${body}'`, { encoding: 'utf8' });
  return JSON.parse(result);
}

function decodeString(hex) {
  if (!hex || hex === '0x') return '';
  const strHex = hex.slice(128);
  const bytes = strHex.match(/.{2}/g) || [];
  return bytes.map(b => String.fromCharCode(parseInt(b, 16))).join('').replace(/\0/g, '');
}

async function scanEulerWallet(walletAddress) {
  console.log(`\n=== Scanning Euler for ${walletAddress.slice(0,12)} ===`);
  
  // 1. Get DeFiLlama APYs
  const pools = await httpsGet('https://yields.llama.fi/pools');
  const eulerPools = pools.data.filter(p => p.project === 'euler-v2' && p.chain === 'Ethereum');
  const apyBySymbol = {};
  for (const p of eulerPools) {
    const sym = p.symbol?.toUpperCase();
    if (sym && (!apyBySymbol[sym] || p.tvlUsd > apyBySymbol[sym].tvlUsd)) {
      apyBySymbol[sym] = { apy: p.apy, tvlUsd: p.tvlUsd };
    }
  }
  
  // 2. Get positions from Goldsky subgraph
  const subgraphResult = await httpsPost(SUBGRAPH_URL, {
    query: `{ trackingVaultBalances(where: {account: "${walletAddress.toLowerCase()}", balance_gt: "0"}) { vault balance debt } }`
  });
  
  const positions = subgraphResult.data?.trackingVaultBalances || [];
  console.log(`Found ${positions.length} Euler positions`);
  
  const results = [];
  
  for (const pos of positions) {
    const vault = pos.vault;
    
    // Get symbol via Alchemy
    const symbolResult = alchemyCall(vault, '0x95d89b41');
    const symbol = decodeString(symbolResult.result);
    
    // Get totalAssets and totalSupply
    const assetsResult = alchemyCall(vault, '0x01e1d114');
    const supplyResult = alchemyCall(vault, '0x18160ddd');
    
    const totalAssets = BigInt(assetsResult.result || '0x0');
    const totalSupply = BigInt(supplyResult.result || '0x0');
    
    const balance = BigInt(pos.balance);
    const sharePrice = totalSupply > 0n ? Number(totalAssets) / Number(totalSupply) : 0;
    const assetsValue = Number(balance) * sharePrice;
    
    // Match APY from DeFiLlama - try multiple patterns
    let underlyingSymbol = symbol.replace(/^e/, '').replace(/-\d+$/, '');
    const symUpper = underlyingSymbol.toUpperCase();
    let apyInfo = apyBySymbol[symUpper];
    if (!apyInfo) apyInfo = apyBySymbol[symbol.toUpperCase()];
    if (!apyInfo) apyInfo = apyBySymbol['RLUSD'];
    if (!apyInfo) apyInfo = apyBySymbol['PYUSD'];
    
    // Debug: show available symbols
    console.log(`  Looking for: ${symUpper}, Found: ${apyInfo ? 'yes' : 'no'}`);
    
    const valueM = assetsValue / 1e18 / 1e6;
    console.log(`${underlyingSymbol}: $${valueM.toFixed(2)}M, APY: ${apyInfo ? apyInfo.apy?.toFixed(2)+'%' : 'not found'}`);
    
    results.push({
      vault, symbol, underlyingSymbol,
      balance: pos.balance, debt: pos.debt,
      assetsValue: assetsValue / 1e18,
      apy: apyInfo?.apy || null
    });
  }
  
  return results;
}

(async () => {
  const results = await scanEulerWallet('0x3063c5907faa10c01b242181aa689beb23d2bd65');
  console.log('\n--- Summary ---');
  for (const r of results) {
    console.log(`${r.underlyingSymbol}: $${(r.assetsValue/1e6).toFixed(2)}M, APY: ${r.apy?.toFixed(2)}%`);
  }
})().catch(console.error);
