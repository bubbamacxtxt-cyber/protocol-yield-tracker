const Database = require('better-sqlite3');
const db = new Database('/home/node/.openclaw/workspace/protocol-yield-tracker-dev/yield-tracker.db');

// Check Euler positions - what data do we have?
const positions = db.prepare(`
  SELECT p.id, p.wallet, p.chain, p.position_type, p.position_index, p.net_usd, p.asset_usd, p.health_rate
  FROM positions p
  WHERE p.protocol_name = 'Euler'
`).all();

console.log('Euler positions:');
for (const p of positions) {
  console.log(JSON.stringify(p, null, 2));
}
