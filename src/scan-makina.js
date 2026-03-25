const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'yield-tracker.db'));
const API = 'https://pro-openapi.debank.com';
const KEY = process.env.DEBANK_API_KEY;

async function api(p) {
    const r = await fetch(API + p, {headers:{'Accept':'application/json','AccessKey':KEY}});
    return r.json();
}

async function main() {
    const wallets = [
        '0xd1a1c248b253f1fc60eacd90777b9a63f8c8c1bc',
        '0xbeef123217647014429b7670329782e210884e89'
    ];

    const posStmt = db.prepare(`
        INSERT OR REPLACE INTO positions (wallet,chain,protocol_id,protocol_name,position_type,strategy,yield_source,health_rate,net_usd,asset_usd,debt_usd)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    const tokStmt = db.prepare(`
        INSERT INTO position_tokens (position_id,role,symbol,real_symbol,real_name,address,amount,price_usd,value_usd)
        VALUES (?,?,?,?,?,?,?,?,?)
    `);

    for (const addr of wallets) {
        console.log(`Scanning ${addr.slice(0,10)}...`);
        const chains = await api('/v1/user/used_chain_list?id=' + addr);

        for (const c of chains) {
            const bal = await api('/v1/user/chain_balance?id=' + addr + '&chain_id=' + c.id);
            if ((bal.usd_value || 0) < 50000) continue;

            const data = await api('/v1/user/complex_protocol_list?id=' + addr + '&chain_id=' + c.id);
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

                    // Classify strategy
                    const supplyUsd = assetTokens.filter(t => (t.amount||0) > 0).reduce((s,t) => s + Math.abs(t.amount||0) * (t.price||0), 0);
                    const borrowUsd = assetTokens.filter(t => (t.amount||0) < 0).reduce((s,t) => s + Math.abs(t.amount||0) * (t.price||0), 0);
                    let strategy = 'unknown';
                    const posType = item.name || '';
                    if (posType === 'Lending') {
                        strategy = supplyUsd > 0 && borrowUsd > 0 && borrowUsd/supplyUsd > 0.7 ? 'loop' : borrowUsd > 0 ? 'borrow' : 'lend';
                    } else if (posType === 'Yield' || posType === 'Deposit') { strategy = 'yield'; }
                    else if (posType === 'Staked' || posType === 'Locked') { strategy = 'stake'; }
                    else if (posType === 'Farming' || posType === 'Leveraged Farming') { strategy = 'farm'; }
                    else if (posType === 'Liquidity Pool') { strategy = 'lp'; }

                    // Save position
                    const result = posStmt.run(
                        addr, c.id, proto.id || '?', proto.name || '?',
                        item.name || '?', strategy, proto.name || '?',
                        hf ? Math.round(hf*1000)/1000 : null,
                        Math.round(net*100)/100, Math.round(assets*100)/100, Math.round(debt*100)/100
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

                    console.log(`  ${c.id}: ${proto.name} ${item.name} $${net.toLocaleString()}`);
                }
            }
            await new Promise(r => setTimeout(r, 150));
        }
    }

    const count = db.prepare('SELECT COUNT(*) as c FROM positions WHERE wallet IN (?,?)').get(wallets[0], wallets[1]);
    console.log(`\nSaved ${count.c} positions for Makina`);
    db.close();
}

main();
