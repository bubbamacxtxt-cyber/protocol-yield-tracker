/**
 * Tree builder: given an adapter's output (possibly nested via row.children),
 * insert rows into exposure_decomposition with correct parent_id / depth /
 * pct_of_parent / pct_of_root.
 *
 * Guardrails:
 *  - Max recursion depth: 6 (paranoid; realistic trees are 2-3 deep)
 *  - Loop guard by (venue_address, asset_address) path
 */

const { validateRow } = require('./adapters/_base');

const MAX_DEPTH = 6;

function insertTree(db, positionId, rows, rootUsd, adapterId) {
  const stmt = db.prepare(`
    INSERT INTO exposure_decomposition
      (position_id, parent_id, depth, kind, venue, venue_address, chain,
       asset_symbol, asset_address, usd, pct_of_parent, pct_of_root, utilization,
       adapter, source, confidence, as_of, attestation_url, evidence_json)
    VALUES (@position_id, @parent_id, @depth, @kind, @venue, @venue_address, @chain,
            @asset_symbol, @asset_address, @usd, @pct_of_parent, @pct_of_root, @utilization,
            @adapter, @source, @confidence, @as_of, @attestation_url, @evidence_json)
  `);

  let count = 0;

  function walk(row, parentId, parentUsd, depth, pathKey) {
    if (depth > MAX_DEPTH) return;
    validateRow(row, adapterId);

    const pctParent = parentUsd > 0 ? (row.usd / parentUsd) * 100 : null;
    const pctRoot   = rootUsd   > 0 ? (row.usd / rootUsd)   * 100 : null;

    const info = stmt.run({
      position_id: positionId,
      parent_id: parentId,
      depth,
      kind: row.kind,
      venue: row.venue || null,
      venue_address: (row.venue_address || '').toLowerCase() || null,
      chain: row.chain || null,
      asset_symbol: row.asset_symbol || null,
      asset_address: (row.asset_address || '').toLowerCase() || null,
      usd: row.usd,
      pct_of_parent: row.pct_of_parent != null ? row.pct_of_parent : pctParent,
      pct_of_root:   pctRoot,
      utilization: row.utilization != null ? row.utilization : null,
      adapter: adapterId,
      source: row.source,
      confidence: row.confidence,
      as_of: row.as_of || null,
      attestation_url: row.attestation_url || null,
      evidence_json: row.evidence != null ? JSON.stringify(row.evidence) : null,
    });
    count++;

    const thisId = info.lastInsertRowid;
    const children = Array.isArray(row.children) ? row.children : [];
    if (!children.length) return;

    const nextPath = `${pathKey}>${row.venue_address || row.asset_address || row.venue || row.asset_symbol || ''}`;
    if (pathKey.includes(nextPath)) return; // loop guard

    for (const c of children) walk(c, thisId, row.usd, depth + 1, nextPath);
  }

  const tx = db.transaction(() => {
    for (const r of rows) walk(r, null, rootUsd, 0, '');
  });
  tx();

  return count;
}

module.exports = { insertTree, MAX_DEPTH };
