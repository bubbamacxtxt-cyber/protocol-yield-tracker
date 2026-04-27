/**
 * Orchestrator: load positions → dispatch to adapter → write decomposition tree.
 * See docs/secondary-risk-coverage-plan.md §5.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { ensureSchema } = require('./schema');
const { loadAllAdapters, resolveAdapter } = require('./registry');
const { insertTree } = require('./recurse');
const { unknownRow } = require('./adapters/_base');

const DB_PATH = path.join(__dirname, '..', '..', 'yield-tracker.db');
const MANUAL_PATH = path.join(__dirname, '..', '..', 'data', 'manual-positions.json');

// Synthetic ids for manual positions start at MANUAL_ID_BASE so they never
// collide with autoincrement values from the positions table. We allocate a
// separate row per manual item inside positions (with is_manual=1 flag) so
// exposure_decomposition FK still works. Existing code path: manual positions
// are re-inserted idempotently each run, keyed on (wallet, chain, protocol_id,
// yield_source).


function loadPositions(db) {
  // Pull every position row + a compact supply/borrow summary so adapters don't
  // have to re-query. Adapter can still hit the DB via ctx.db for deeper data.
  return db.prepare(`
    SELECT
      p.id, p.wallet, p.chain, p.protocol_id, p.protocol_name,
      p.position_type, p.strategy, p.yield_source, p.health_rate,
      p.net_usd, p.asset_usd, p.debt_usd, p.position_index,
      p.scanned_at
    FROM positions p
    WHERE p.net_usd >= 50000
    ORDER BY p.net_usd DESC
  `).all();
}

function upsertManualPositions(db) {
  // Pull manual-positions.json and upsert into the positions table so they
  // flow through the same adapter dispatch as scanner output. We do *not*
  // write position_tokens for manual rows (export.js doesn't either) — adapters
  // should tolerate empty token lists.
  if (!fs.existsSync(MANUAL_PATH)) return 0;
  let manual = {};
  try { manual = JSON.parse(fs.readFileSync(MANUAL_PATH, 'utf8')); } catch { return 0; }
  const all = [];
  for (const [whale, items] of Object.entries(manual)) {
    if (!Array.isArray(items)) continue;
    for (const it of items) all.push({ ...it, _whale: whale });
  }
  if (!all.length) return 0;

  const stmt = db.prepare(`
    INSERT INTO positions
      (wallet, chain, protocol_id, protocol_name, position_type, strategy,
       yield_source, health_rate, net_usd, asset_usd, debt_usd, position_index, scanned_at)
    VALUES (@wallet, @chain, @protocol_id, @protocol_name, @position_type, @strategy,
            @yield_source, @health_rate, @net_usd, @asset_usd, @debt_usd, @position_index, datetime('now'))
    ON CONFLICT(wallet, chain, protocol_id, position_index) DO UPDATE SET
      net_usd = excluded.net_usd,
      asset_usd = excluded.asset_usd,
      debt_usd = excluded.debt_usd,
      protocol_name = excluded.protocol_name,
      scanned_at = excluded.scanned_at
  `);
  let n = 0;
  for (const it of all) {
    try {
      stmt.run({
        wallet: (it.wallet || 'off-chain').toLowerCase(),
        chain: it.chain || 'off-chain',
        protocol_id: it.protocol_id || it.protocol_name,
        protocol_name: it.protocol_name,
        position_type: it.position_type || 'Manual',
        strategy: it.strategy || 'manual',
        yield_source: it.yield_source || null,
        health_rate: it.health_rate || null,
        net_usd: Number(it.net_usd || 0),
        asset_usd: Number(it.asset_usd || it.net_usd || 0),
        debt_usd: Number(it.debt_usd || 0),
        position_index: it.position_index || `${it.wallet || 'offchain'}|${it.chain || 'offchain'}|${it.protocol_id || it.protocol_name}`,
      });
      n++;
    } catch (err) {
      console.warn(`[exposure] manual upsert failed for ${it.protocol_name}: ${err.message}`);
    }
  }
  return n;
}

function loadTokens(db, positionId) {
  return db.prepare(`
    SELECT role, symbol, real_symbol, address, amount, price_usd, value_usd
    FROM position_tokens WHERE position_id = ?
  `).all(positionId);
}

function loadProtocolCanonicals(db) {
  // Map position.id -> protocol_canonical by running the same canonicalization
  // that export.js uses. We inline the lowercase comparison here; the registry
  // file in data/protocol-registry.json has authoritative aliases.
  const regPath = path.join(__dirname, '..', '..', 'data', 'protocol-registry.json');
  let reg = {};
  try { reg = JSON.parse(require('fs').readFileSync(regPath, 'utf8')).protocols || {}; } catch {}
  const byAlias = new Map();
  for (const [key, entry] of Object.entries(reg)) {
    for (const a of (entry.aliases || [])) byAlias.set(String(a).toLowerCase(), key);
    for (const n of (entry.name_aliases || [])) byAlias.set(String(n).toLowerCase(), key);
  }
  return function canonicalize(p) {
    const byId = byAlias.get(String(p.protocol_id || '').toLowerCase());
    const byName = byAlias.get(String(p.protocol_name || '').toLowerCase());
    return byId || byName || String(p.protocol_id || '').toLowerCase() || String(p.protocol_name || '').toLowerCase().replace(/\s+/g, '-');
  };
}

function upsertAdapterHealth(db, adapterId, fields) {
  const row = db.prepare('SELECT * FROM adapter_health WHERE adapter = ?').get(adapterId);
  if (!row) {
    db.prepare(`INSERT INTO adapter_health
      (adapter, last_run, last_success, last_error, last_error_msg, positions_handled, errors, runs)
      VALUES (@adapter, @last_run, @last_success, @last_error, @last_error_msg, @positions_handled, @errors, @runs)`)
      .run({ adapter: adapterId, runs: 1, positions_handled: 0, errors: 0, last_success: null, last_error: null, last_error_msg: null, last_run: null, ...fields });
  } else {
    db.prepare(`UPDATE adapter_health SET
      last_run=@last_run, last_success=COALESCE(@last_success,last_success),
      last_error=COALESCE(@last_error,last_error), last_error_msg=COALESCE(@last_error_msg,last_error_msg),
      positions_handled=positions_handled+@positions_handled, errors=errors+@errors, runs=runs+1
      WHERE adapter=@adapter`).run({ adapter: adapterId, positions_handled: 0, errors: 0, last_success: null, last_error: null, last_error_msg: null, last_run: null, ...fields });
  }
}

async function run({ dryRun = false } = {}) {
  const db = new Database(DB_PATH);
  ensureSchema(db);

  const adapters = loadAllAdapters();
  const canonicalize = loadProtocolCanonicals(db);
  const manualUpserted = upsertManualPositions(db);
  if (manualUpserted) console.log(`[exposure] upserted ${manualUpserted} manual positions`);
  const positions = loadPositions(db);
  const now = new Date().toISOString();

  // Clear previous decomposition for all positions we're about to re-decompose.
  // We scope the wipe to this run so that if the orchestrator fails mid-way,
  // we don't leave a position with zero rows.
  const runStart = now;

  console.log(`[exposure] adapters loaded: ${adapters.map(a => a.id).join(', ')}`);
  console.log(`[exposure] positions: ${positions.length}`);

  const ctx = {
    db, now,
    cache: {
      get(key) { return ctx._cache.get(key); },
      set(key, val) { ctx._cache.set(key, val); },
    },
    _cache: new Map(),
    loadTokens: (positionId) => loadTokens(db, positionId),
  };

  const summary = { total: positions.length, written: 0, errors: 0, by_adapter: {} };

  for (const p of positions) {
    p.protocol_canonical = canonicalize(p);
    const adapter = resolveAdapter(p, adapters);
    const adapterId = adapter ? adapter.id : 'unknown';
    summary.by_adapter[adapterId] = (summary.by_adapter[adapterId] || 0) + 1;

    let rows = [];
    let errorMsg = null;
    try {
      rows = await adapter.compute(p, ctx);
      if (!Array.isArray(rows) || rows.length === 0) {
        rows = [unknownRow({ usd: p.net_usd, reason: 'adapter returned no rows', protocol: p.protocol_name, chain: p.chain })];
      }
    } catch (err) {
      errorMsg = (err && err.stack) ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
      console.error(`[exposure] adapter ${adapterId} failed on position ${p.id} (${p.protocol_name}): ${err.message}`);
      rows = [unknownRow({ usd: p.net_usd, reason: `adapter error: ${err.message}`, protocol: p.protocol_name, chain: p.chain })];
      summary.errors++;
    }

    if (!dryRun) {
      // Clean old rows for this position before writing fresh ones
      db.prepare('DELETE FROM exposure_decomposition WHERE position_id = ?').run(p.id);
      const written = insertTree(db, p.id, rows, p.net_usd, adapterId);
      summary.written += written;
    }

    upsertAdapterHealth(db, adapterId, {
      last_run: now,
      last_success: errorMsg ? null : now,
      last_error: errorMsg ? now : null,
      last_error_msg: errorMsg,
      positions_handled: 1,
      errors: errorMsg ? 1 : 0,
    });
  }

  console.log('[exposure] summary:', JSON.stringify(summary, null, 2));
  db.close();
  return summary;
}

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run };
