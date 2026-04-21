#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ALCHEMY_DISCOVERY = path.join(__dirname, '..', 'data', 'recon', 'alchemy-token-discovery.json');
const STABLES = path.join(__dirname, '..', 'data', 'stables.json');
const VAULTS = path.join(__dirname, '..', 'data', 'vaults.json');
const OUT = path.join(__dirname, '..', 'data', 'recon', 'canonical-token-matches.json');

function loadJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

const discovery = loadJson(ALCHEMY_DISCOVERY, { wallets: [] });
const stablesRaw = loadJson(STABLES, { stables: [] });
const vaultsRaw = loadJson(VAULTS, { vaults: [] });
const stables = Array.isArray(stablesRaw) ? stablesRaw : (stablesRaw.stables || []);
const vaults = Array.isArray(vaultsRaw) ? vaultsRaw : (vaultsRaw.vaults || []);

function byAddress(arr, key) {
  const map = new Map();
  for (const item of arr) {
    const addrs = key === 'stable'
      ? (item.addresses || [])
      : [item.address].filter(Boolean);
    for (const a of addrs) map.set(String(a).toLowerCase(), item);
  }
  return map;
}

const stableMap = byAddress(stables, 'stable');
const vaultMap = byAddress(vaults, 'vault');
const out = [];
for (const wallet of (discovery.wallets || [])) {
  for (const token of (wallet.tokens || [])) {
    const addr = String(token.address || '').toLowerCase();
    if (stableMap.has(addr)) {
      out.push({ wallet: wallet.wallet, address: addr, kind: 'ybs', match: stableMap.get(addr) });
    } else if (vaultMap.has(addr)) {
      out.push({ wallet: wallet.wallet, address: addr, kind: 'vault', match: vaultMap.get(addr) });
    }
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), matches: out }, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Matches: ${out.length}`);
