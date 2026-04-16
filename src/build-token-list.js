#!/usr/bin/env node
/**
 * Protocol Yield Tracker — Token Registry Builder
 * Downloads token lists from 1inch (per chain) + DeFiLlama (global)
 * Run once. CoinGecko is never called here — only by fetch.js for unknowns.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

// Chains we care about (from DeBank scan results)
const CHAINS = {
    eth: 1, arb: 42161, base: 8453, mnt: 5000, plasma: 9745,
    ink: 57073, bsc: 56, op: 10, matic: 137, avax: 43114,
    xdai: 100, scrl: 534352, bera: 80094, flr: 14, blast: 81457,
    hyper: 999, monad: 10143
};

// DeBank chain IDs → our chain names
const DEBANK_CHAINS = {
    'eth': 'eth', 'arb': 'arb', 'base': 'base', 'mnt': 'mnt', 'plasma': 'plasma',
    'ink': 'ink', 'bsc': 'bsc', 'op': 'op', 'matic': 'matic', 'avax': 'avax',
    'xdai': 'xdai', 'scrl': 'scrl', 'bera': 'bera', 'flr': 'flr',
    'blast': 'blast', 'hyper': 'hyper', 'monad': 'monad'
};

async function fetchJson(url) {
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'YieldTracker/1.0' },
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) return null;
        return res.json();
    } catch (e) {
        console.log(`  FAIL: ${url.split('?')[0]} (${e.message})`);
        return null;
    }
}

function initDB() {
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
    return db;
}

async function main() {
    console.log('=== Token Registry Builder ===\n');

    const db = initDB();
    let total = 0;

    // --- 1. DeFiLlama stablecoins (global, one call) ---
    console.log('1. DeFiLlama stablecoins...');
    const llama = await fetchJson('https://stablecoins.llama.fi/stablecoins?includePrices=true');
    if (llama?.peggedAssets) {
        const upsert = db.prepare(`
            INSERT OR IGNORE INTO token_registry (address, chain, symbol, real_symbol, real_name, source)
            VALUES (?, ?, ?, ?, ?, 'defillama')
        `);
        const txn = db.transaction(() => {
            for (const asset of llama.peggedAssets) {
                if (!asset.symbol) continue;
                // Store symbol-level entry under 'global' chain
                upsert.run(`sym:${asset.symbol.toUpperCase()}`, 'global', asset.symbol, asset.symbol, asset.name || '', );
            }
        });
        txn();
        console.log(`   ${llama.peggedAssets.length} stablecoins loaded`);
        total += llama.peggedAssets.length;
    }

    // --- 2. 1inch token list (per chain we care about) ---
    console.log('\n2. 1inch token lists (per chain)...');
    const inchUpset = db.prepare(`
        INSERT OR REPLACE INTO token_registry (address, chain, symbol, real_symbol, real_name, source)
        VALUES (?, ?, ?, ?, ?, '1inch')
    `);

    // Master list (covers eth + many chains)
    const master = await fetchJson('https://tokens.1inch.eth.link/');
    if (master?.tokens) {
        const txn = db.transaction(() => {
            for (const t of master.tokens) {
                const chain = Object.entries(CHAINS).find(([, v]) => v === t.chainId)?.[0] || String(t.chainId);
                inchUpset.run(t.address.toLowerCase(), chain, t.symbol, t.symbol, t.name || '');
            }
        });
        txn();
        console.log(`   Master list: ${master.tokens.length} tokens`);
        total += master.tokens.length;
    }

    // Per-chain lists (some chains might have more tokens)
    for (const [chainName, chainId] of Object.entries(CHAINS)) {
        if (chainId === 1) continue; // Already covered by master list
        await new Promise(r => setTimeout(r, 200)); // Be nice
        const data = await fetchJson(`https://tokens.1inch.io/v6.0/${chainId}`);
        if (data && typeof data === 'object' && !data.message) {
            // v6 format: { "0xaddr": { symbol, name, decimals, logoURI }, ... }
            let count = 0;
            const txn = db.transaction(() => {
                for (const [addr, info] of Object.entries(data)) {
                    if (addr.length !== 42) continue;
                    inchUpset.run(addr.toLowerCase(), chainName, info.symbol || '', info.symbol || '', info.name || '');
                    count++;
                }
            });
            txn();
            if (count > 0) console.log(`   Chain ${chainName}: ${count} tokens`);
            total += count;
        }
    }

    // --- Summary ---
    const counts = db.prepare(`
        SELECT chain, COUNT(*) as count FROM token_registry GROUP BY chain ORDER BY count DESC
    `).all();
    const grandTotal = db.prepare('SELECT COUNT(*) as c FROM token_registry').get().c;

    console.log(`\n${'='.repeat(40)}`);
    console.log(`Registry: ${grandTotal} tokens`);
    for (const row of counts) {
        console.log(`  ${row.chain.padEnd(12)} ${row.count}`);
    }

    // Save as JSON for reference
    const allTokens = db.prepare('SELECT * FROM token_registry').all();
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'token-registry.json'), JSON.stringify(allTokens, null, 2));

    db.close();
    console.log('\nDone. Registry ready for fetch.js to use.');
}

main().catch(console.error);
