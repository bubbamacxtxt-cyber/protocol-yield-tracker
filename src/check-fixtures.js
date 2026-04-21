#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data.json');
const FIXTURE_PATH = path.join(__dirname, '..', 'data', 'regression-fixtures.json');

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).fixtures || [];

function allPositions() {
  const rows = [];
  for (const [whale, group] of Object.entries(data.whales || {})) {
    for (const p of group.positions || []) rows.push({ whale, ...p });
  }
  return rows;
}

const rows = allPositions();
const failures = [];
const passes = [];

for (const fixture of fixtures) {
  if (!fixture.expects || fixture.expects.length === 0) continue;
  const walletRows = rows.filter(r => String(r.wallet || '').toLowerCase() === String(fixture.wallet || '').toLowerCase());
  for (const exp of fixture.expects) {
    const match = walletRows.find(r => {
      if (exp.protocol_id && String(r.protocol_id || '') !== exp.protocol_id) return false;
      if (exp.protocol_name && String(r.protocol_name || '') !== exp.protocol_name) return false;
      if (exp.supply_symbol && String(r.supply_tokens_display || '') !== exp.supply_symbol) return false;
      if (exp.min_net_usd != null && Number(r.net_usd || 0) < exp.min_net_usd) return false;
      return true;
    });
    if (match) {
      passes.push({ fixture: fixture.name, expect: exp, matched_protocol_id: match.protocol_id, matched_net_usd: match.net_usd });
    } else {
      failures.push({ fixture: fixture.name, expect: exp });
    }
  }
}

console.log(JSON.stringify({ passes, failures, summary: { passes: passes.length, failures: failures.length } }, null, 2));
if (failures.length > 0) process.exit(1);
