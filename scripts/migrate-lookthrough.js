#!/usr/bin/env node
/**
 * Add position_lookthrough table to existing DB
 * 
 * Run once to migrate. Safe to re-run (CREATE TABLE IF NOT EXISTS).
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

function migrate() {
  const db = new Database(DB_PATH);
  console.log(`[migrate] opening ${DB_PATH}`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS position_lookthrough (
      id INTEGER PRIMARY KEY,
      position_id INTEGER REFERENCES positions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      market_key TEXT,
      collateral_symbol TEXT,
      collateral_address TEXT,
      loan_symbol TEXT,
      loan_address TEXT,
      chain TEXT,
      total_supply_usd REAL,
      total_borrow_usd REAL,
      utilization REAL,
      pro_rata_usd REAL,
      share_pct REAL,
      rank_order INTEGER,
      metadata_json TEXT,
      computed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(position_id, kind, market_key, collateral_address)
    );
    CREATE INDEX IF NOT EXISTS idx_lookthrough_position ON position_lookthrough(position_id);
    CREATE INDEX IF NOT EXISTS idx_lookthrough_market ON position_lookthrough(kind, market_key);
  `);

  const tableInfo = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='position_lookthrough'`).get();
  if (tableInfo) {
    console.log('[migrate] position_lookthrough table created (or already exists)');
    console.log('[migrate] done');
  } else {
    console.error('[migrate] FAILED to create position_lookthrough table');
    process.exit(1);
  }

  db.close();
}

migrate();
