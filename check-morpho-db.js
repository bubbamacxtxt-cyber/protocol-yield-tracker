const db = require('better-sqlite3')('/home/node/.openclaw/workspace/protocol-yield-tracker/yield-tracker.db');
const rows = db.prepare(`
    SELECT p.wallet, p.protocol_id, pt.role, pt.symbol, pt.address, pt.value_usd
    FROM position_tokens pt
    JOIN positions p ON pt.position_id = p.id
    WHERE p.protocol_id LIKE '%morpho%'
    AND pt.role = 'supply'
    ORDER BY p.wallet, p.protocol_id, pt.value_usd DESC
`).all();

console.log('Current Morpho supply tokens in DB:');
rows.forEach(r => {
    console.log(
        r.wallet.slice(0, 10) + ' ' +
        r.protocol_id.padEnd(20) +
        r.role.padEnd(8) +
        r.symbol.padEnd(20) +
        '$' + (r.value_usd / 1e6).toFixed(1) + 'M  addr: ' + r.address.slice(0, 10)
    );
});
console.log('\nTotal:', rows.length);
