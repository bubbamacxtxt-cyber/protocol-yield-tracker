#!/usr/bin/env node
/**
 * Build Lookthrough — Position Risk Lookthrough Orchestrator
 *
 * Reads positions from the DB, routes them to the appropriate lookthrough module
 * (Morpho, Aave, Euler, etc.), computes pro-rata exposure to underlying
 * collateral in each pool/vault, and writes lookthrough rows.
 *
 * Run after all scanners in the hourly pipeline.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

async function main() {
  console.log('[lookthrough] build-lookthrough starting');

  const db = new Database(DB_PATH);

  // Read all scanner-owned positions (exclude wallet-held, ethena-cooldown, YBS)
  const positions = db.prepare(`
    SELECT id, wallet, chain, protocol_id, protocol_name, position_type,
           strategy, health_rate, net_usd, asset_usd, debt_usd, position_index,
           scanned_at
    FROM positions
    WHERE protocol_id IN ('morpho', 'aave-v3', 'spark-savings', 'spark-savings-legacy', 'euler2', 'fluid-lending', 'fluid-vault', 'compound', 'curve')
      AND net_usd > 0
    ORDER BY protocol_id, asset_usd DESC
  `).all();

  console.log(`[lookthrough] ${positions.length} positions to process`);

  // Clear stale lookthrough rows (from previous scan cycle)
  const scanStart = new Date().toISOString();
  db.prepare(`DELETE FROM position_lookthrough WHERE computed_at < datetime('2024-01-01')`).run();

  // Route to lookthrough modules
  const morphoPositions = positions.filter(p => p.protocol_id === 'morpho');
  const aavePositions = positions.filter(p => ['aave-v3', 'spark-savings', 'spark-savings-legacy'].includes(p.protocol_id));
  const eulerPositions = positions.filter(p => ['euler2'].includes(p.protocol_id));
  const fluidPositions = positions.filter(p => ['fluid-lending', 'fluid-vault'].includes(p.protocol_id));

  // Group by protocol
  let totalRows = 0;

  if (morphoPositions.length > 0) {
    const { compute } = require('./lookthrough/morpho');
    const morphoRows = await compute(morphoPositions, db);
    totalRows += morphoRows.length;
    await insertLookthroughRows(db, morphoRows);
  }

  if (aavePositions.length > 0) {
    const { compute } = require('./lookthrough/aave');
    const aaveRows = await compute(aavePositions, db);
    totalRows += aaveRows.length;
    await insertLookthroughRows(db, aaveRows);
  }

  // Future: add aave, spark, euler, etc. modules here
  // if (aavePositions.length > 0) { ... }

  console.log(`[lookthrough] ${totalRows} lookthrough rows written`);
  console.log('[lookthrough] build-lookthrough complete');

  db.close();
}

async function insertLookthroughRows(db, rows) {
  if (rows.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO position_lookthrough (
      position_id, kind, market_key, collateral_symbol, collateral_address,
      loan_symbol, loan_address, chain, total_supply_usd, total_borrow_usd,
      utilization, pro_rata_usd, share_pct, rank_order, metadata_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(position_id, kind, market_key, collateral_address) DO UPDATE SET
      total_supply_usd = excluded.total_supply_usd,
      total_borrow_usd = excluded.total_borrow_usd,
      utilization = excluded.utilization,
      pro_rata_usd = excluded.pro_rata_usd,
      share_pct = excluded.share_pct,
      rank_order = excluded.rank_order,
      computed_at = datetime('now')
  `);

  const tx = db.transaction((rows) => {
    for (const r of rows) {
      insert.run(
        r.position_id, r.kind, r.market_key, r.collateral_symbol, r.collateral_address,
        r.loan_symbol, r.loan_address, r.chain, r.total_supply_usd, r.total_borrow_usd,
        r.utilization, r.pro_rata_usd, r.share_pct, r.rank_order, null
      );
    }
  });

  tx(rows);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[lookthrough] FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main, insertLookthroughRows };
