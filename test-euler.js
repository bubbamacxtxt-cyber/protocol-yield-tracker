const https = require('https');

function fetch(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  // First, get vault info from Euler RPC to find underlying asset and APY
  // We'll call the Lens contracts via Euler's RPC proxy
  
  // RLUSD vault: 0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2
  // PYUSD vault: 0xba98fc35c9dfd69178ad5dce9fa29c64554783b5
  
  const vaults = [
    '0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2',
    '0xba98fc35c9dfd69178ad5dce9fa29c64554783b5'
  ];
  
  for (const vault of vaults) {
    console.log(`\nVault: ${vault}`);
    
    // Call asset() to get underlying asset
    // function selector for asset() is 0x52ef1b7d
    const result = await fetch('https://app.euler.finance/api/rpc/1', {
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{
        to: vault,
        data: '0x52ef1b7d'  // asset()
      }, 'latest'],
      id: 1
    });
    
    console.log('asset() result:', JSON.stringify(result));
  }
}

main().catch(console.error);
