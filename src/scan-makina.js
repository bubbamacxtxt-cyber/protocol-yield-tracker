const Database = require('better-sqlite3');
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

    const posStmt = db.prepare('INSERT OR REPLACE INTO positions (wallet,chain,protocol_id,protocol_name,position_type,strategy,yield_source,health_rate,net_usd,asset_usd,debt_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?)');

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
                    const net = item.stats?.net_usd_value || 0;
                    if (net < 50000) continue;
                    const hf = item.detail?.health_rate || null;
                    const assets = item.stats?.asset_usd_value || 0;
                    const debt = item.stats?.debt_usd_value || 0;
                    posStmt.run(addr, c.id, proto.id || '?', proto.name || '?', item.name || '?', 'yield', proto.name || '?', hf ? Math.round(hf*1000)/1000 : null, Math.round(net*100)/100, Math.round(assets*100)/100, Math.round(debt*100)/100);
                    console.log(`  ${c.id}: ${proto.name} $${net.toLocaleString()}`);
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
