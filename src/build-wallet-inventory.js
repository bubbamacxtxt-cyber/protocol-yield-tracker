#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const WHALES = path.join(__dirname, '..', 'data', 'whales.json');
const OUT = path.join(__dirname, '..', 'data', 'recon', 'wallet-inventory.json');

const whales = JSON.parse(fs.readFileSync(WHALES, 'utf8'));
const rows = [];
for (const [entity, def] of Object.entries(whales)) {
  if (Array.isArray(def)) {
    for (const wallet of def) rows.push({ entity, wallet: wallet.toLowerCase(), vault: null, entity_type: 'onchain' });
  } else if (def.vaults) {
    for (const [vault, wallets] of Object.entries(def.vaults)) {
      for (const wallet of wallets) rows.push({ entity, wallet: wallet.toLowerCase(), vault, entity_type: 'onchain' });
    }
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), wallets: rows }, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Wallets: ${rows.length}`);
