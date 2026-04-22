const fs = require('fs');
const path = require('path');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
const positions = data.whales['Avant'].positions || [];
function key(p) {
  const s = (p.supply||[])[0] || {};
  const b = (p.borrow||[])[0] || {};
  return [String(p.wallet||'').toLowerCase(), String(p.chain||'').toLowerCase(), String(p.protocol_id||'').toLowerCase(), String(s.address||s.symbol||'').toLowerCase(), String(b.address||b.symbol||'').toLowerCase()].join('||');
}
const map = new Map();
for (const p of positions) {
  const k = key(p);
  if (!map.has(k)) map.set(k, []);
  map.get(k).push({ net:p.net_usd, asset:p.asset_usd, debt:p.debt_usd, apy:p.apy_base, cost:p.apy_cost, wallet:p.wallet });
}
for (const [k,v] of map.entries()) if (v.length>1) console.log(k, JSON.stringify(v,null,2));
