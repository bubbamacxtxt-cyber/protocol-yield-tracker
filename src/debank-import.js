#!/usr/bin/env node
/**
 * debank-import.js — Import positions from the daily DeBank recon for
 * protocols we don't have dedicated scanners for yet.
 *
 * Why: protocols like Dolomite, Curvance, Gearbox, Venus, LFJ use naked-
 * deposit patterns (no share token minted, positions tracked internally
 * by a margin/strategy contract). Building a full scanner for each is
 * high cost for low yield. Until we do, import the DeBank recon row
 * directly so the position is visible in dashboards.
 *
 * Runs once per day after build-debank-recon.js (in recon-daily.yml).
 * Rows get `source_type='debank'` so the source-audit report flags them
 * and they're clearly distinguishable from scanner-owned positions.
 *
 * Staleness: DeBank recon is daily. If a whale exits one of these
 * positions between recon cycles we'll be up to 24h stale. Acceptable
 * tradeoff vs. running DeBank hourly (which costs real API credits).
 *
 * When we build a real scanner for any of these, remove the protocol_id
 * from DEBANK_IMPORT_PROTOCOLS and from purge-stale-positions.js's
 * DEBANK_ONLY_PROTOCOLS list.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const POSITIONS_PATH = path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-positions.json');

// Protocols where we don't yet have a dedicated scanner AND the DeBank data
// is useful enough to import as a transitional position.
//
// Add/remove entries as scanners are built. Keep this list TIGHT \u2014 we don't
// want to import DeBank data for protocols that overlap with scanner coverage
// (which would double-count).
const DEBANK_IMPORT_PROTOCOLS = new Set([
  'dolomite',
  'monad_curvance',
  'monad_gearbox',
  'bsc_venusflux',
  'avax_traderjoexyz',
  'monad_traderjoexyz',
  'ethstrat',
  'plasma_yuzumoney',
]);

function normalizeProtoName(protoId, dbName) {
  // If DeBank gives us a clean name use it; fall back to title-cased id
  if (dbName && !/^\s*$/.test(dbName)) return dbName;
  return (protoId || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function main() {
  if (!fs.existsSync(POSITIONS_PATH)) {
    console.error('Missing debank-wallet-positions.json — run build-debank-recon.js first.');
    process.exit(1);
  }
  const debank = JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8'));
  const positions = debank.positions || [];
  console.log(`DeBank recon generated: ${debank.generated_at}`);
  console.log(`Total positions in recon: ${positions.length}`);

  const db = new Database(DB_PATH);

  // Find matching rows
  const toImport = positions.filter(p =>
    DEBANK_IMPORT_PROTOCOLS.has(p.protocol_id || '') &&
    (p.total_usd || 0) >= 10000  // skip dust
  );
  console.log(`Importing ${toImport.length} DeBank-only positions\n`);

  const upsertPos = db.prepare(`
    INSERT INTO positions (
      wallet, chain, protocol_id, protocol_name, position_type, strategy,
      yield_source, net_usd, asset_usd, debt_usd, position_index,
      debank_updated_at, scanned_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO NOTHING
  `);

  const findExisting = db.prepare(`
    SELECT id FROM positions
    WHERE lower(wallet) = ? AND chain = ? AND protocol_id = ? AND position_index = ?
  `);

  const updateExisting = db.prepare(`
    UPDATE positions
    SET protocol_name = ?, position_type = ?, strategy = ?, yield_source = ?,
        net_usd = ?, asset_usd = ?, debt_usd = ?,
        debank_updated_at = ?, scanned_at = datetime('now')
    WHERE id = ?
  `);

  const delToks = db.prepare('DELETE FROM position_tokens WHERE position_id = ?');
  const insTok = db.prepare(`
    INSERT INTO position_tokens
      (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `);

  let imported = 0, updated = 0;
  let totalUsd = 0;
  for (const p of toImport) {
    const wallet = (p.wallet || '').toLowerCase();
    const chain = p.chain;
    const protocolId = p.protocol_id;
    const protocolName = normalizeProtoName(protocolId, p.protocol_name);
    const poolId = p.raw?.pool?.id || protocolId;
    const positionIndex = `${protocolId}:${poolId}`;

    const assetUsd = p.raw?.stats?.asset_usd_value || p.total_usd || 0;
    const debtUsd = p.raw?.stats?.debt_usd_value || 0;
    const netUsd = (p.raw?.stats?.net_usd_value != null) ? p.raw.stats.net_usd_value : (assetUsd - debtUsd);

    const itemName = p.item_name || '';
    const strategy = /borrow|lever/i.test(itemName) ? 'lend-borrow'
                   : /yield|earn|lend/i.test(itemName) ? 'lend'
                   : /liquid|lp/i.test(itemName) ? 'lp'
                   : 'lend';

    const debankUpdatedAt = p.raw?.update_at
      ? new Date(p.raw.update_at * 1000).toISOString()
      : null;

    const existing = findExisting.get(wallet, chain, protocolId, positionIndex);
    let posId;
    if (existing) {
      updateExisting.run(
        protocolName, itemName || 'Position', strategy,
        `debank-import:${protocolId}`,
        netUsd, assetUsd, debtUsd,
        debankUpdatedAt, existing.id
      );
      posId = existing.id;
      updated++;
    } else {
      const res = upsertPos.run(
        wallet, chain, protocolId, protocolName,
        itemName || 'Position', strategy,
        `debank-import:${protocolId}`,
        netUsd, assetUsd, debtUsd, positionIndex,
        debankUpdatedAt
      );
      posId = res.lastInsertRowid;
      imported++;
    }

    // Rebuild token rows from DeBank data
    delToks.run(posId);
    const supplyList = p.raw?.detail?.supply_token_list || [];
    const borrowList = p.raw?.detail?.borrow_token_list || [];
    for (const t of supplyList) {
      insTok.run(posId, 'supply', t.symbol || '?', t.id || t.address || null,
        t.amount || null, t.price || null, (t.amount || 0) * (t.price || 0));
    }
    for (const t of borrowList) {
      insTok.run(posId, 'borrow', t.symbol || '?', t.id || t.address || null,
        t.amount || null, t.price || null, (t.amount || 0) * (t.price || 0));
    }

    totalUsd += netUsd;
    const symbols = supplyList.map(t => t.symbol).filter(Boolean).join('+') || '?';
    console.log(`  ${protocolId.padEnd(22)} $${(netUsd / 1e6).toFixed(2).padStart(7)}M  ${wallet.slice(0, 12)}  ${chain.padEnd(8)}  ${symbols}`);
  }

  console.log(`\nImported ${imported}, updated ${updated} \u2014 total $${(totalUsd / 1e6).toFixed(2)}M`);
  db.close();
}

if (require.main === module) main();
