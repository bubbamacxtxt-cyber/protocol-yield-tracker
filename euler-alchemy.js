const https = require('https');
require('dotenv').config();

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;

function alchemyCall(params) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [params, 'latest'],
      id: 1
    });
    
    const req = https.request({
      hostname: 'eth-mainnet.g.alchemy.com',
      path: `/v2/${ALCHEMY_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function decodeAddress(hex) {
  // Decode address from 32-byte word (remove leading zeros)
  return '0x' + hex.slice(-40);
}

function decodeUint(hex) {
  return BigInt(hex);
}

async function main() {
  const vaults = [
    '0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2',
    '0xba98fc35c9dfd69178ad5dce9fa29c64554783b5'
  ];
  
  for (const vault of vaults) {
    console.log(`\nVault: ${vault}`);
    
    // Call asset() to get underlying asset - selector 0x52ef1b7d
    const assetResult = await alchemyCall({
      to: vault,
      data: '0x52ef1b7d'
    });
    
    if (assetResult.result) {
      const asset = decodeAddress(assetResult.result);
      console.log('Underlying asset:', asset);
    }
    
    // Call symbol() - selector 0x95d89b41
    const symbolResult = await alchemyCall({
      to: vault,
      data: '0x95d89b41'
    });
    
    if (symbolResult.result) {
      const symbol = Buffer.from(symbolResult.result.slice(2), 'hex').toString().replace(/\0/g, '');
      console.log('Symbol:', symbol);
    }
    
    // Call totalAssets() - selector 0x01e1d114
    const totalAssetsResult = await alchemyCall({
      to: vault,
      data: '0x01e1d114'
    });
    
    if (totalAssetsResult.result) {
      const totalAssets = decodeUint(totalAssetsResult.result);
      console.log('Total assets:', totalAssets.toString());
    }
    
    // Call totalBorrow() - need to find selector or use IRM
    // For now, let's try supplyRate and borrowRate from the IRM
    
    // Call interestRateModel() - selector 0x9014e6d1
    const irmResult = await alchemyCall({
      to: vault,
      data: '0x9014e6d1'
    });
    
    if (irmResult.result) {
      const irm = decodeAddress(irmResult.result);
      console.log('IRM:', irm);
    }
  }
}

main().catch(console.error);
