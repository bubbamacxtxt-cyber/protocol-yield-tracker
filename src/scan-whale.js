const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'yield-tracker.db'));
const API = 'https://pro-openapi.debank.com';
const KEY = process.env.DEBANK_API_KEY;

async function api(p) {
    const r = await fetch(API + p, { headers: { 'Accept': 'application/json', 'AccessKey': KEY } });
    return r.json();
}

const MONEY_MARKETS = ['aave', 'morpho', 'euler', 'spark', 'compound', 'fluid', 'venus'];

function getDisplayType(item, protocolName) {
    const isMM = MONEY_MARKETS.some(mm => (protocolName || '').toLowerCase().includes(mm));
    return isMM ? 'Lending' : (item.name || '?');
}

function classifyStrategy(displayType, supplyUsd, borrowUsd, hf) {
    if (displayType === 'Lending') return (borrowUsd > 0 || hf) ? 'loop' : 'lend';
    if (displayType === 'Farming' || displayType === 'Leveraged Farming') return 'farm';
    if (displayType === 'Staked' || displayType === 'Locked') return 'stake';
    if (displayType === 'Liquidity Pool') return 'lp';
    if (displayType === 'Yield' || displayType === 'Deposit') return (borrowUsd > 0 || hf) ? 'loop' : 'lend';
    return 'unknown';
}

async function scanWallets(wallets, label) {
    console.log(`\n=== Scanning ${label} (${wallets.length} wallets) ===\n`);
    
    const posStmt = db.prepare(`
        INSERT OR REPLACE INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, yield_source, health_rate, net_usd, asset_usd, debt_usd, position_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tokStmt = db.prepare(`
        INSERT INTO position_tokens (position_id, role, symbol, real_symbol, real_name, address, amount, price_usd, value_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalPositions = 0;

    for (const addr of wallets) {
        const short = addr.slice(0, 8) + '...';
        const chains = await api(`/v1/user/used_chain_list?id=${addr}`);
        let walletPositions = 0;

        for (const c of chains) {
            const bal = await api(`/v1/user/chain_balance?id=${addr}&chain_id=${c.id}`);
            if ((bal.usd_value || 0) < 50000) continue;

            const data = await api(`/v1/user/complex_protocol_list?id=${addr}&chain_id=${c.id}`);
            if (!Array.isArray(data)) continue;

            for (const proto of data) {
                for (const item of proto.portfolio_item_list || []) {
                    const stats = item.stats || {};
                    const net = stats.net_usd_value || 0;
                    if (net < 50000) continue;

                    const detail = item.detail || {};
                    const assetTokens = item.asset_token_list || [];
                    const hf = detail.health_rate || null;
                    const assets = stats.asset_usd_value || 0;
                    const debt = stats.debt_usd_value || 0;

                    const supplyUsd = assetTokens.filter(t => (t.amount || 0) > 0).reduce((s, t) => s + Math.abs(t.amount || 0) * (t.price || 0), 0);
                    const borrowUsd = assetTokens.filter(t => (t.amount || 0) < 0).reduce((s, t) => s + Math.abs(t.amount || 0) * (t.price || 0), 0);

                    const displayType = getDisplayType(item, proto.name);
                    const strategy = classifyStrategy(displayType, supplyUsd, borrowUsd, hf);

                    // Generate unique position_index from token addresses (DeBank often returns undefined)
                    const tokenAddrs = assetTokens.map(t => t.id || '').sort().join(',');
                    const uniqueIndex = item.position_index || tokenAddrs || `pos_${Date.now()}`;

                    // Delete old tokens for this position (if replacing)
                    const existingPos = db.prepare('SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = ? AND position_index = ?').get(addr, c.id, proto.id || '?', uniqueIndex);
                    if (existingPos) {
                        db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(existingPos.id);
                    }

                    // Save position
                    const result = posStmt.run(
                        addr, c.id, proto.id || '?', proto.name || '?',
                        displayType, strategy, proto.name || '?',
                        hf ? Math.round(hf * 1000) / 1000 : null,
                        Math.round(net * 100) / 100,
                        Math.round(assets * 100) / 100,
                        Math.round(debt * 100) / 100,
                        uniqueIndex
                    );
                    const posId = result.lastInsertRowid;

                    // Save tokens
                    const saveTokens = db.transaction(() => {
                        for (const t of assetTokens) {
                            const amount = Math.abs(t.amount || 0);
                            const price = t.price || 0;
                            const role = (t.amount || 0) > 0 ? 'supply' : 'borrow';
                            tokStmt.run(posId, role, t.symbol || '?', t.symbol || '?', t.name || '', t.id || '', amount, price, amount * price);
                        }
                    });
                    saveTokens();

                    walletPositions++;
                }
            }
            await new Promise(r => setTimeout(r, 150));
        }

        if (walletPositions > 0) {
            console.log(`  ${short}: ${walletPositions} positions`);
            totalPositions += walletPositions;
        }
    }

    console.log(`  Total: ${totalPositions} positions`);
    return totalPositions;
}

// Load whale definitions
const WHALES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));

async function main() {
    const label = process.argv[2];
    if (!label || !WHALES[label]) {
        console.error('Usage: node src/scan-whale.js <whale-name>');
        console.error('Available:', Object.keys(WHALES).join(', '));
        process.exit(1);
    }

    const def = WHALES[label];
    let wallets;
    if (Array.isArray(def)) {
        wallets = def;
    } else if (def.vaults) {
        wallets = Object.values(def.vaults).flat();
    } else {
        console.error('Invalid whale definition');
        process.exit(1);
    }

    await scanWallets(wallets, label);
    db.close();
}

main();
