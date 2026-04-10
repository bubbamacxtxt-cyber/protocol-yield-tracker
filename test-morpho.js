const https = require('https');

async function morphoGraphQL(query) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ query });
        const req = https.request('https://api.morpho.org/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        }, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.errors) {
                        reject(new Error(`GraphQL: ${JSON.stringify(result.errors)}`));
                    } else {
                        resolve(result.data);
                    }
                } catch(e) {
                    reject(new Error(body.slice(0, 200)));
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

(async () => {
    const wallet = '0x7bee8D37FBA61a6251a08b957d502C56E2A50FAb';
    const query = `{
        userByAddress(address: "${wallet}") {
            marketPositions {
                supplyAssetsUsd
                borrowAssetsUsd
                market {
                    uniqueKey
                    collateralAsset { symbol address }
                    loanAsset { symbol address }
                }
            }
        }
    }`;
    
    console.log('Testing Morpho query with https...');
    try {
        const result = await morphoGraphQL(query);
        console.log('Success!');
        const positions = result?.userByAddress?.marketPositions || [];
        console.log('Positions:', positions.length);
        positions.filter(p => p.supplyAssetsUsd > 100 || p.borrowAssetsUsd > 100).forEach(p => {
            console.log('  Key:', p.market?.uniqueKey);
            console.log('  Collat:', p.market?.collateralAsset?.symbol, p.market?.collateralAsset?.address);
            console.log('  Loan:', p.market?.loanAsset?.symbol);
        });
    } catch(e) {
        console.log('Error:', e.message);
    }
    
    // Now test with fetch()
    console.log('\nTesting with fetch()...');
    try {
        const res = await fetch('https://api.morpho.org/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
            timeout: 15000
        });
        const text = await res.text();
        console.log('Status:', res.status);
        console.log('Response (first 300):', text.slice(0, 300));
    } catch(e) {
        console.log('Fetch error:', e.message);
    }
})();
