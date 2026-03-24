#!/usr/bin/env node
/**
 * Protocol Yield Tracker — Token List Builder
 * Downloads token lists from multiple sources, stores in DB
 * Run once, then fetch.js uses the cached registry
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

async function fetchJson(url) {
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'YieldTracker/1.0' }
        });
        if (!res.ok) { console.log(`  FAIL ${url} (${res.status})`); return null; }
        return res.json();
    } catch (e) {
        console.log(`  FAIL ${url} (${e.message})`);
        return null;
    }
}

async function main() {
    console.log('=== Building Token Registry ===\n');

    const db = new Database(DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS token_registry (
            address TEXT NOT NULL,
            chain TEXT NOT NULL,
            symbol TEXT,
            real_symbol TEXT,
            real_name TEXT,
            cg_id TEXT,
            cg_price_usd REAL,
            source TEXT,
            last_checked TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (address, chain)
        );
    `);

    const upsert = db.prepare(`
        INSERT OR REPLACE INTO token_registry (address, chain, symbol, real_symbol, real_name, cg_id, source, last_checked)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    let total = 0;

    // 1. 1inch token list (address→symbol, all chains)
    console.log('1. 1inch token list...');
    const inchData = await fetchJson('https://tokens.1inch.eth.link/');
    if (inchData?.tokens) {
        const txn = db.transaction(() => {
            for (const t of inchData.tokens) {
                const chain = chainIdToName(t.chainId);
                upsert.run(t.address.toLowerCase(), chain, t.symbol, t.symbol, t.name || '', null, '1inch');
            }
        });
        txn();
        console.log(`   ${inchData.tokens.length} tokens loaded`);
        total += inchData.tokens.length;
    }

    // 2. DeFiLlama stablecoins (symbol-level, no addresses)
    console.log('2. DeFiLlama stablecoins...');
    const llamaData = await fetchJson('https://stablecoins.llama.fi/stablecoins?includePrices=true');
    if (llamaData?.peggedAssets) {
        const txn = db.transaction(() => {
            for (const asset of llamaData.peggedAssets) {
                // Store by symbol only (no address from this endpoint)
                // Use chain='global' to indicate it's a symbol-level entry
                const sym = asset.symbol || '';
                if (!sym) continue;
                upsert.run(`symbol:${sym.toUpperCase()}`, 'global', sym, sym, asset.name || asset.id || '', null, 'defillama');
            }
        });
        txn();
        console.log(`   ${llamaData.peggedAssets.length} stablecoins loaded`);
        total += llamaData.peggedAssets.length;
    }

    // 3. CoinGecko top coins (symbol-level)
    console.log('3. CoinGecko top 250...');
    const cgData = await fetchJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=1');
    if (cgData && Array.isArray(cgData)) {
        const txn = db.transaction(() => {
            for (const coin of cgData) {
                const sym = (coin.symbol || '').toUpperCase();
                if (!sym) continue;
                upsert.run(`symbol:${sym}`, 'global', coin.symbol, coin.symbol, coin.name || '', coin.id || '', 'coingecko_top');
            }
        });
        txn();
        console.log(`   ${cgData.length} tokens loaded`);
        total += cgData.length;
    }

    // Summary
    const count = db.prepare('SELECT COUNT(*) as c FROM token_registry').get().c;
    console.log(`\nTotal in registry: ${count} tokens`);

    // Save as JSON too
    const allTokens = db.prepare('SELECT * FROM token_registry').all();
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'token-registry.json'), JSON.stringify(allTokens, null, 2));
    console.log('Saved to data/token-registry.json');

    db.close();
}

function chainIdToName(id) {
    const map = {
        1: 'eth', 56: 'bsc', 137: 'matic', 42161: 'arb', 10: 'op',
        43114: 'avax', 8453: 'base', 100: 'xdai', 324: 'zksync',
        5000: 'mnt', 9745: 'plasma', 57073: 'ink'
    };
    return map[id] || String(id);
}

main().catch(console.error);
