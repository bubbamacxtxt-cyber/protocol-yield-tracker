const https = require('https');
const Database = require('better-sqlite3');

const db = new Database('./yield-tracker.db');

async function morphoGraphQL(address) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            query: `{ userByAddress(address: "${address}") { marketPositions { supplyAssetsUsd borrowAssetsUsd market { uniqueKey collateralAsset { symbol address } loanAsset { symbol address } } } } }`
        });
        const req = https.request('https://api.morpho.org/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const r = JSON.parse(data);
                    if (res.statusCode !== 200) { reject(new Error('HTTP' + res.statusCode + ': ' + data.slice(0, 200))); return; }
                    resolve(r.data?.userByAddress?.marketPositions || []);
                } catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

(async () => {
    console.log('=== Morpho Token Fix ===');
    const morphoWallets = db.prepare("SELECT DISTINCT wallet FROM positions WHERE protocol_id LIKE '%morpho%'").all();
    console.log('Wallets with Morpho positions:', morphoWallets.length);

    let fixed = 0, matched = 0;
    for (const row of morphoWallets) {
        const wallet = row.wallet;
        try {
            const positions = await morphoGraphQL(wallet);
            if (positions.length === 0) continue;

            const active = positions.filter(p => p.supplyAssetsUsd > 100 || p.borrowAssetsUsd > 100);
            if (active.length === 0) continue;

            console.log('\nWallet:', wallet.slice(0, 10) + '... (' + active.length + ' active positions)');

            for (const mp of active) {
                const loan = mp.market?.loanAsset;
                const collateral = mp.market?.collateralAsset;
                if (!loan || !collateral) continue;

                const loanAddr = loan.address?.toLowerCase() || '';
                if (!loanAddr) continue;

                const dbRow = db.prepare(
                    "SELECT pt.id, pt.symbol, pt.address, p.id as pos_id FROM position_tokens pt JOIN positions p ON pt.position_id = p.id WHERE p.wallet = ? AND pt.address = ? AND pt.role = 'supply' AND p.protocol_id LIKE '%morpho%'"
                ).get(wallet, loanAddr);

                if (!dbRow) continue;
                matched++;

                const correctAddress = collateral.address.toLowerCase();
                if (dbRow.address.toLowerCase() !== correctAddress) {
                    db.prepare('UPDATE position_tokens SET symbol = ?, real_symbol = ?, address = ? WHERE id = ?').run(
                        collateral.symbol, collateral.symbol, correctAddress, dbRow.id
                    );
                    fixed++;
                    console.log('  FIXED:', dbRow.symbol.slice(0, 15), '(' + dbRow.address.slice(0, 10) + ') ->', collateral.symbol, '(' + correctAddress.slice(0, 10) + ')');
                } else {
                    console.log('  OK:', dbRow.symbol);
                }
            }
        } catch(e) {
            console.log('  ERROR:', wallet.slice(0, 10), e.message.slice(0, 80));
        }
        await new Promise(r => setTimeout(r, 300));
    }

    console.log('\nResults: ' + fixed + ' fixed, ' + matched + ' matched out of ' + morphoWallets.length + ' wallets');
})();
