#!/usr/bin/env node
/**
 * Protocol Yield Tracker — Data Export
 * Reads SQLite database, exports to data.json for dashboard
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const OUT_PATH = path.join(__dirname, '..', 'data.json');

function main() {
    const db = new Database(DB_PATH, { readonly: true });

    // Load positions with token data
    const positions = db.prepare(`
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

    // Parse token JSON
    for (const p of positions) {
        p.supply = JSON.parse(p.supply_json || '[]');
        p.borrow = JSON.parse(p.borrow_json || '[]');
        p.rewards = JSON.parse(p.reward_json || '[]');
        delete p.supply_json;
        delete p.borrow_json;
        delete p.reward_json;
    }

    // Load wallets
    const wallets = db.prepare('SELECT DISTINCT wallet FROM positions').all().map(r => r.wallet);
    const totalWallets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'wallets.json'), 'utf8')).length;
    const activeWallets = wallets.length;

    // Load token registry
    const tokenRegistry = db.prepare('SELECT * FROM token_registry').all();

    // Build whale structure
    const whales = {
        'Avant': {
            name: 'Avant',
            wallets: wallets,
            total_wallets: totalWallets,
            active_wallets: activeWallets,
            positions: positions
        }
    };

    // Summary stats
    const summary = {
        total_positions: positions.length,
        total_value: positions.reduce((s, p) => s + p.net_usd, 0),
        total_debt: positions.reduce((s, p) => s + p.debt_usd, 0),
        total_assets: positions.reduce((s, p) => s + p.asset_usd, 0),
        by_protocol: {},
        by_chain: {},
        by_strategy: {}
    };

    for (const p of positions) {
        // By protocol
        if (!summary.by_protocol[p.protocol_name]) {
            summary.by_protocol[p.protocol_name] = { count: 0, total: 0 };
        }
        summary.by_protocol[p.protocol_name].count++;
        summary.by_protocol[p.protocol_name].total += p.net_usd;

        // By chain
        if (!summary.by_chain[p.chain]) {
            summary.by_chain[p.chain] = { count: 0, total: 0 };
        }
        summary.by_chain[p.chain].count++;
        summary.by_chain[p.chain].total += p.net_usd;

        // By strategy
        if (!summary.by_strategy[p.strategy]) {
            summary.by_strategy[p.strategy] = { count: 0, total: 0 };
        }
        summary.by_strategy[p.strategy].count++;
        summary.by_strategy[p.strategy].total += p.net_usd;
    }

    // Export
    const data = {
        generated_at: new Date().toISOString(),
        summary,
        whales,
        token_registry_count: tokenRegistry.length
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
    console.log(`Exported ${positions.length} positions to data.json`);

    // Generate CSV for Google Sheets
    const csvPath = path.join(__dirname, '..', 'data-avant.csv');
    const csvHeader = 'Wallet,Chain,Protocol,Type,Strategy,Health Rate,Net USD,Asset USD,Debt USD,Supply Tokens,Borrow Tokens,Reward Tokens';
    const csvRows = positions.map(p => {
        const supply = p.supply.map(t => `${t.real_symbol || t.symbol}: ${t.amount.toLocaleString()} ($${(t.value_usd/1e6).toFixed(2)}M)`).join(' + ');
        const borrow = p.borrow.map(t => `${t.real_symbol || t.symbol}: ${t.amount.toLocaleString()} ($${(t.value_usd/1e6).toFixed(2)}M)`).join(' + ');
        const rewards = p.rewards.map(t => `${t.real_symbol || t.symbol}: ${t.amount}`).join(' + ');
        return [
            p.wallet,
            p.chain,
            p.protocol_name,
            p.position_type,
            p.strategy,
            p.health_rate || '',
            p.net_usd,
            p.asset_usd,
            p.debt_usd,
            `"${supply}"`,
            `"${borrow}"`,
            `"${rewards}"`
        ].join(',');
    });
    fs.writeFileSync(csvPath, [csvHeader, ...csvRows].join('\n'));
    console.log(`Exported CSV to data-avant.csv`);

    db.close();
}

main();
