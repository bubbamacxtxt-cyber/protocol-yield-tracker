#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const DEBANK_KEY = process.env.DEBANK_API_KEY;
const WHALES = path.join(__dirname, '..', 'data', 'whales.json');
const OUT_SUMMARY = path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-summary.json');
const OUT_POSITIONS = path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-positions.json');
const CHAIN_SCAN_THRESHOLD_USD = 50000;

if (!DEBANK_KEY) {
  console.error('Missing DEBANK_API_KEY');
  process.exit(1);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'AccessKey': DEBANK_KEY } });
  if (!res.ok) {
    console.error(`DeBank ${res.status} for ${url}`);
    return null;
  }
  return res.json();
}

async function main() {
  const whales = JSON.parse(fs.readFileSync(WHALES, 'utf8'));
  const wallets = [];
  for (const [entity, def] of Object.entries(whales)) {
    if (Array.isArray(def)) {
      for (const wallet of def) wallets.push({ whale: entity, wallet: wallet.toLowerCase() });
    } else if (def.vaults) {
      for (const [vault, list] of Object.entries(def.vaults)) {
        for (const wallet of list) wallets.push({ whale: entity, vault, wallet: wallet.toLowerCase() });
      }
    }
  }

  const summary = [];
  const positions = [];
  fs.mkdirSync(path.dirname(OUT_SUMMARY), { recursive: true });

  for (const w of wallets) {
    const all = await fetchJson(`https://pro-openapi.debank.com/v1/user/all_complex_protocol_list?id=${w.wallet}`);
    if (!all) continue;

    const chainMap = new Map();
    for (const proto of all) {
      const chain = String(proto.chain || 'unknown').toLowerCase();
      const items = Array.isArray(proto.portfolio_item_list) ? proto.portfolio_item_list : [];
      let protoNetUsd = 0;
      for (const item of items) {
        const stats = item.stats || {};
        const itemNet = Number(stats.net_usd_value ?? stats.asset_usd_value ?? 0);
        protoNetUsd += itemNet;

        positions.push({
          whale: w.whale,
          vault: w.vault || null,
          wallet: w.wallet,
          chain,
          protocol_name: proto.name || '',
          protocol_id: proto.id || '',
          item_name: item.name || '',
          total_usd: itemNet,
          raw: item
        });
      }
      if (!chainMap.has(chain)) chainMap.set(chain, { chain, total_usd: 0, protocols: [], active_for_position_scan: false, scan_threshold_usd: CHAIN_SCAN_THRESHOLD_USD });
      const entry = chainMap.get(chain);
      entry.total_usd += protoNetUsd;
      entry.protocols.push({
        protocol_name: proto.name || '',
        protocol_id: proto.id || '',
        total_usd: protoNetUsd,
        chain
      });
    }

    const chains = [...chainMap.values()].map(c => ({
      ...c,
      active_for_position_scan: c.total_usd >= CHAIN_SCAN_THRESHOLD_USD
    }));
    summary.push({
      whale: w.whale,
      vault: w.vault || null,
      wallet: w.wallet,
      chains
    });
  }

  fs.writeFileSync(OUT_SUMMARY, JSON.stringify({ generated_at: new Date().toISOString(), wallets: summary }, null, 2));
  fs.writeFileSync(OUT_POSITIONS, JSON.stringify({ generated_at: new Date().toISOString(), positions }, null, 2));
  console.log(`Wrote ${OUT_SUMMARY}`);
  console.log(`Wrote ${OUT_POSITIONS}`);
  console.log(`Wallets scanned: ${summary.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
