const https = require('https');

const WALLETS = [
    '0x0000000f2eb9f69274678c76222b35eec7588a65',
    '0x7bee8D37FBA61a6251a08b957d502C56E2A50FAb',
    '0x3207363359Ca0c11D11073aD48301E8c958B7910',
];

async function morphoGraphQL(address) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            query: `{ userByAddress(address: "${address}") { marketPositions { supplyAssetsUsd borrowAssetsUsd market { uniqueKey collateralAsset { symbol address } loanAsset { symbol address } } } } }`,
        });
        const req = https.request('https://api.morpho.org/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 500)));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

(async () => {
    for (const addr of WALLETS) {
        try {
            const r = await morphoGraphQL(addr);
            const positions = r.data?.userByAddress?.marketPositions || [];
            const active = positions.filter(p => p.supplyAssetsUsd > 100 || p.borrowAssetsUsd > 100);
            console.log(addr.slice(0, 10) + '...:', active.length, 'active positions');
            active.forEach(p => {
                console.log('  Key:', p.market?.uniqueKey?.slice(0, 20) + '...');
                console.log('  Collat:', p.market?.collateralAsset?.symbol, '| Loan:', p.market?.loanAsset?.symbol);
            });
        } catch (e) {
            console.log(addr.slice(0, 10) + '...', 'ERROR:', e.message.slice(0, 100));
        }
    }
})();
