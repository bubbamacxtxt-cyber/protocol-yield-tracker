/**
 * exposure_decomposition table — unified secondary risk lookthrough
 * See docs/secondary-risk-coverage-plan.md §4.
 */

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exposure_decomposition (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      parent_id INTEGER,
      depth INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      venue TEXT,
      venue_address TEXT,
      chain TEXT,
      asset_symbol TEXT,
      asset_address TEXT,
      usd REAL NOT NULL,
      pct_of_parent REAL,
      pct_of_root REAL,
      utilization REAL,
      adapter TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence TEXT NOT NULL,
      as_of TEXT,
      attestation_url TEXT,
      evidence_json TEXT,
      computed_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id)   REFERENCES exposure_decomposition(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_expdec_position   ON exposure_decomposition(position_id);
    CREATE INDEX IF NOT EXISTS idx_expdec_parent     ON exposure_decomposition(parent_id);
    CREATE INDEX IF NOT EXISTS idx_expdec_kind_conf  ON exposure_decomposition(kind, confidence);
    CREATE INDEX IF NOT EXISTS idx_expdec_adapter    ON exposure_decomposition(adapter);

    CREATE TABLE IF NOT EXISTS ybs_backing_cache (
      token_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      composition_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (token_address, chain)
    );

    CREATE TABLE IF NOT EXISTS borrower_mix_cache (
      market_key TEXT NOT NULL,      -- '{chainId}:{marketAddress}:{loanAsset}'
      mix_json TEXT NOT NULL,
      total_borrowers INTEGER,
      total_borrow_usd REAL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (market_key)
    );

    CREATE TABLE IF NOT EXISTS adapter_health (
      adapter TEXT PRIMARY KEY,
      last_run TEXT,
      last_success TEXT,
      last_error TEXT,
      last_error_msg TEXT,
      positions_handled INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      runs INTEGER DEFAULT 0
    );
  `);
}

module.exports = { ensureSchema };
