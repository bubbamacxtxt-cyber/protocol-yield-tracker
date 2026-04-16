#!/usr/bin/env node
/**
 * fetch-vaults.js — Fetch vault data from IPOR and Upshift (August Digital)
 * Normalizes all rates to APY, writes to vaults table + vault_apy_history
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const IPOR_API = 'https://api.ipor.io/dapp/plasma-vaults-list';
const AUGUST_API = 'https://api.augustdigital.io/api/v1/tokenized_vault/';

const CHAIN_MAP = { 1: 'eth', 130: 'unichain', 8453: 'base', 9745: 'plasma', 42161: 'arbitrum' };

function aprToApy(aprPct) {
  return (Math.exp(aprPct / 100) - 1) * 100;
}

async function fetchIpor() {
  console.log('Fetching IPOR vaults...');
  const res = await fetch(IPOR_API, { headers: { 'Accept-Encoding': 'gzip' } });
  if (!res.ok) throw new Error(`IPOR API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const vaults = data.plasmaVaults || [];
  console.log(`  Got ${vaults.length} IPOR vaults`);
  return vaults.map(v => ({
    address: v.address.toLowerCase(),
    symbol: v.vaultSymbol,
    name: v.name,
    chain: v.chainId,
    chain_name: CHAIN_MAP[v.chainId] || String(v.chainId),
    vault_type: 'IPOR Fusion',
    status: 'active',
    tvl_usd: parseInt(v.tvlUsd_18 || '0') / 1e18,
    apy_1d: aprToApy(parseFloat(v.apr || '0')),
    apy_7d: null,
    apy_30d: null,
    source: 'ipor',
    max_drawdown: null,
    rating: v.xerberusVaultRating || null,
    fetched_at: new Date().toISOString(),
  }));
}

async function fetchUpshift() {
  console.log('Fetching Upshift vaults from August Digital API...');
  const db = new Database(DB_PATH);
  const existing = db.prepare("SELECT address FROM vaults WHERE source = 'upshift'").all();
  db.close();
  if (existing.length === 0) { console.log('  No Upshift vaults in DB yet'); return []; }

  const vaults = [];
  for (const row of existing) {
    try {
      const res = await fetch(AUGUST_API + row.address);
      if (!res.ok) { console.log(`  ❌ ${row.address}: API ${res.status}`); continue; }
      const data = await res.json();
      const apy30 = (data.historical_apy?.['30'] || 0) * 100;
      const apy7 = (data.historical_apy?.['7'] || 0) * 100;
      const apy1 = (data.historical_apy?.['1'] || 0) * 100;
      const tvl = data.latest_reported_tvl || 0;
      vaults.push({
        address: row.address.toLowerCase(), tvl_usd: tvl,
        apy_1d: apy1, apy_7d: apy7, apy_30d: apy30,
        source: 'upshift', fetched_at: new Date().toISOString(),
      });
      console.log(`  📡 ${row.address.slice(0,10)}...: 30d=${apy30.toFixed(2)}% 7d=${apy7.toFixed(2)}% tvl=$${(tvl/1e6).toFixed(1)}M`);
      await new Promise(r => setTimeout(r, 1100));
    } catch (e) { console.log(`  ❌ ${row.address}: ${e.message}`); }
  }
  console.log(`  Got ${vaults.length} Upshift vaults`);
  return vaults;
}

async function main() {
  const db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS vault_apy_history (
    vault_address TEXT NOT NULL, source TEXT NOT NULL, timestamp TEXT NOT NULL,
    apy REAL, tvl_usd REAL, PRIMARY KEY (vault_address, timestamp))`);
  try { db.exec('ALTER TABLE vaults ADD COLUMN rating TEXT'); } catch (e) {}

  const now = new Date().toISOString();
  const iporVaults = await fetchIpor();
  const upshiftVaults = await fetchUpshift();

  const upsertIpor = db.prepare(`INSERT INTO vaults (address, symbol, name, chain, chain_name, vault_type, status, tvl_usd, apy_1d, apy_7d, apy_30d, source, max_drawdown, rating, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET tvl_usd=excluded.tvl_usd, apy_1d=excluded.apy_1d, rating=excluded.rating,
      fetched_at=excluded.fetched_at, status=excluded.status, vault_type=excluded.vault_type,
      chain_name=excluded.chain_name, symbol=excluded.symbol, name=excluded.name`);

  // Compute 7d/30d from history for IPOR
  const historyRows = db.prepare(`SELECT vault_address,
    AVG(CASE WHEN timestamp >= datetime('now','-1 day') THEN apy END) as apy_1d,
    AVG(CASE WHEN timestamp >= datetime('now','-7 days') THEN apy END) as apy_7d,
    AVG(CASE WHEN timestamp >= datetime('now','-30 days') THEN apy END) as apy_30d
    FROM vault_apy_history WHERE source='ipor' GROUP BY vault_address`).all();
  const historyApy = {};
  for (const r of historyRows) historyApy[r.vault_address] = r;

  const insertHistory = db.prepare(`INSERT OR IGNORE INTO vault_apy_history (vault_address, source, timestamp, apy, tvl_usd) VALUES (?, ?, ?, ?, ?)`);
  let iporCount = 0;
  for (const v of iporVaults) {
    const h = historyApy[v.address];
    if (h) { if (h.apy_7d != null) v.apy_7d = h.apy_7d; if (h.apy_30d != null) v.apy_30d = h.apy_30d; }
    upsertIpor.run(v.address, v.symbol, v.name, v.chain, v.chain_name, v.vault_type, v.status, v.tvl_usd, v.apy_1d, v.apy_7d, v.apy_30d, v.source, v.max_drawdown, v.rating, v.fetched_at);
    insertHistory.run(v.address, v.source, now, v.apy_1d, v.tvl_usd);
    iporCount++;
  }
  console.log(`  Wrote ${iporCount} IPOR vaults`);

  const updateUpshift = db.prepare(`UPDATE vaults SET apy_1d=?, apy_7d=?, apy_30d=?, tvl_usd=?, fetched_at=? WHERE address=?`);
  let upCount = 0;
  for (const v of upshiftVaults) {
    updateUpshift.run(v.apy_1d, v.apy_7d, v.apy_30d, v.tvl_usd, v.fetched_at, v.address);
    insertHistory.run(v.address, v.source, now, v.apy_30d, v.tvl_usd);
    upCount++;
  }
  console.log(`  Updated ${upCount} Upshift vaults`);
  db.close();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
