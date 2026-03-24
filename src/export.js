#!/usr/bin/env node
/**
 * Protocol Yield Tracker — Data Export (Multi-Whale)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const OUT_PATH = path.join(__dirname, '..', 'data.json');

// Whale definitions: name → wallet addresses
const WHALES = {
    'Avant': [
        '0x020c5bB0d81b8cf539Ca06364Ece4a41631995b4',
        '0x887fD380C1e4Cc28e119917015fE7fb0062c5d67',
        '0xB2e193a469D73634b116810d647960ad00Db321D',
        '0x1Ae4190c55c2986130694aF6998A94126C0685cd',
        '0xc29ff89a2dE0c0E8A358a933A8B00692cDe452b5',
        '0xC1d023141ad6935F81E5286E577768b75C9Ff8EB',
        '0x5b53358ECA5790fA4c268aD6813386B3A86549C7',
        '0xFbbF1826Aba90704A2167D2EB4A7a9D83A8DE9c7',
        '0x1DFF1e9968222aa6c66BF402baC2C3FE5Ed13F76',
        '0x3207363359Ca0c11D11073aD48301E8c958B7910',
        '0x7bee8D37FBA61a6251a08b957d502C56E2A50FAb',
        '0x920EefBCf1f5756109952E6Ff6dA1Cab950C64d7',
        '0xD2305803Ca7821e4E5C3bcAeD366AD7dE9F13739',
        '0xe5971fd226433d5D3a926c9fc99BbDd1E5953146',
        '0xc2d2C22f54c9Fae2456b6E7f7fBdC240E1898DA1',
        '0xAcABC577f359e4Af4Dd057af56de5A576ba9Bd82',
        '0xD2Fb3766A7d191AFfaa8Ab5C40B6A67007Aa3A5d',
        '0xc468315a2df54f9c076bD5Cfe5002BA211F74CA6',
        '0x33A4866bffc90791e65Da0d339eDdcaE3d9ce9F9',
        '0x3BbCb84fCDE71063D8C396e6C54F5dC3D19EE0EC'
    ],
    'yoUSD': [
        '0x0000000f2eb9f69274678c76222b35eec7588a65'
    ],
    'Yuzu': [
        '0x815f5BB257e88b67216a344C7C83a3eA4EE74748',
        '0x015CC48cC8bC37D80AAFf4e43061dbaF94192308',
        '0x502D222e8e4DaEF69032f55F0c1A999EFFd78fB3',
        '0xCf0a12CBd8088fc5f84ad431E71787157041cD69',
        '0xb6cbe8b123392eF6Aa72897bb85bd6515d2e8db7',
        '0xfAA7744b9Ed973290A36eE815b5AcC76856583a0',
        '0x424323D25d30C687BDf79Bb333da1D41C0373F37',
        '0xDAeF005ae017Be5B938A2b321Db3dEC96e684f68',
        '0x6695c0f8706C5ACe3Bdf8995073179cCA47926dc',
        '0x09bfBC374C37c927909a0E7B278eE7Fdf47A380a'
    ]
};

function main() {
    const db = new Database(DB_PATH, { readonly: true });

    // Load all positions with token data
    const allPositions = db.prepare(`
        SELECT p.*,
            (SELECT json_group_array(json_object(
                'symbol', pt.symbol, 'real_symbol', pt.real_symbol, 'real_name', pt.real_name,
                'address', pt.address, 'amount', pt.amount, 'price_usd', pt.price_usd, 'value_usd', pt.value_usd
            )) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'supply') as supply_json,
            (SELECT json_group_array(json_object(
                'symbol', pt.symbol, 'real_symbol', pt.real_symbol, 'real_name', pt.real_name,
                'address', pt.address, 'amount', pt.amount, 'price_usd', pt.price_usd, 'value_usd', pt.value_usd
            )) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'borrow') as borrow_json,
            (SELECT json_group_array(json_object(
                'symbol', pt.symbol, 'real_symbol', pt.real_symbol,
                'amount', pt.amount, 'value_usd', pt.value_usd
            )) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'reward') as reward_json
        FROM positions p
        ORDER BY p.net_usd DESC
    `).all();

    for (const p of allPositions) {
        p.supply = JSON.parse(p.supply_json || '[]');
        p.borrow = JSON.parse(p.borrow_json || '[]');
        p.rewards = JSON.parse(p.reward_json || '[]');
        delete p.supply_json;
        delete p.borrow_json;
        delete p.reward_json;
    }

    // Build whale data
    const whales = {};
    for (const [name, walletList] of Object.entries(WHALES)) {
        const walletSet = new Set(walletList.map(w => w.toLowerCase()));
        const positions = allPositions.filter(p => walletSet.has(p.wallet.toLowerCase()));

        whales[name] = {
            name,
            wallets: walletList,
            total_wallets: walletList.length,
            active_wallets: [...new Set(positions.map(p => p.wallet))].length,
            positions
        };
    }

    // Global summary
    let totalPositions = 0, totalValue = 0, totalAssets = 0, totalDebt = 0, totalWallets = 0, totalActive = 0;
    const allChains = new Set(), allProtos = new Set();

    for (const w of Object.values(whales)) {
        totalPositions += w.positions.length;
        totalWallets += w.total_wallets;
        totalActive += w.active_wallets;
        for (const p of w.positions) {
            totalValue += p.net_usd;
            totalAssets += p.asset_usd;
            totalDebt += p.debt_usd;
            allChains.add(p.chain);
            allProtos.add(p.protocol_name);
        }
    }

    const data = {
        generated_at: new Date().toISOString(),
        summary: {
            total_positions: totalPositions,
            total_value: totalValue,
            total_assets: totalAssets,
            total_debt: totalDebt,
            total_whales: Object.keys(whales).length,
            total_wallets: totalWallets,
            total_active: totalActive,
            chains: [...allChains],
            protocols: [...allProtos]
        },
        whales
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
    console.log(`Exported ${totalPositions} positions across ${Object.keys(whales).length} whales`);

    for (const [name, w] of Object.entries(whales)) {
        console.log(`  ${name}: ${w.positions.length} positions, ${w.active_wallets}/${w.total_wallets} wallets active`);
    }

    db.close();
}

main();
