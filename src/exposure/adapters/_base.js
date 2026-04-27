/**
 * Shared helpers for exposure adapters.
 *
 * An adapter exports:
 *   module.exports = {
 *     id: 'aave',                          // stable adapter id
 *     protocol_names: ['Aave V3'],         // matches position.protocol_name or protocol_canonical
 *     protocol_canonicals: ['aave'],       // optional, matches protocol_canonical
 *     confidence: 'high' | 'medium' | 'low',
 *     references: [ 'https://...' ],
 *     async compute(position, ctx) -> ExposureRow[]
 *   };
 *
 * ExposureRow shape (strict):
 *   {
 *     kind: 'primary_asset' | 'pool_share' | 'market_exposure' | 'ybs_strategy'
 *         | 'lp_underlying' | 'pendle_underlying' | 'opaque_offchain' | 'unknown',
 *     venue?: string,
 *     venue_address?: string,
 *     chain?: string,
 *     asset_symbol?: string,
 *     asset_address?: string,
 *     usd: number,
 *     pct_of_parent?: number,              // 0..100
 *     utilization?: number,                // 0..1
 *     source: 'onchain'|'subgraph'|'protocol-api'|'manual'|'cached',
 *     confidence: 'high'|'medium'|'low',
 *     as_of?: string,                      // ISO
 *     attestation_url?: string,
 *     evidence?: any,                      // serialized to evidence_json
 *     children?: ExposureRow[]             // recursion; parent_id wired by orchestrator
 *   }
 *
 * Orchestrator guarantees:
 *   - ctx.db is a better-sqlite3 handle
 *   - ctx.now is an ISO string for this run
 *   - ctx.cache.get/set provide TTL-aware caching (per adapter)
 *   - ctx.recurse(subPosition) lets an adapter defer to another adapter for a child
 *   - Errors thrown by compute() are caught, logged to adapter_health, and
 *     converted to an `unknown` row for that position.
 */

const ROW_KINDS = new Set([
  'primary_asset', 'pool_share', 'market_exposure', 'ybs_strategy',
  'lp_underlying', 'pendle_underlying', 'opaque_offchain', 'unknown',
]);

const ROW_SOURCES = new Set(['onchain', 'subgraph', 'protocol-api', 'manual', 'cached']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);

function validateRow(row, adapterId) {
  if (!row || typeof row !== 'object') throw new Error(`[${adapterId}] row must be an object`);
  if (!ROW_KINDS.has(row.kind)) throw new Error(`[${adapterId}] invalid kind: ${row.kind}`);
  if (!ROW_SOURCES.has(row.source)) throw new Error(`[${adapterId}] invalid source: ${row.source}`);
  if (!CONFIDENCES.has(row.confidence)) throw new Error(`[${adapterId}] invalid confidence: ${row.confidence}`);
  if (typeof row.usd !== 'number' || !isFinite(row.usd)) throw new Error(`[${adapterId}] usd must be finite number`);
  return row;
}

function opaqueRow({ venue, counterparty, usd, attestationUrl, note, asOf }) {
  return {
    kind: 'opaque_offchain',
    venue: venue || counterparty,
    asset_symbol: null,
    usd,
    source: 'manual',
    confidence: 'medium',
    as_of: asOf || null,
    attestation_url: attestationUrl || null,
    evidence: { counterparty, note: note || null },
  };
}

function primaryAssetRow({ symbol, address, chain, usd, pct }) {
  return {
    kind: 'primary_asset',
    asset_symbol: symbol,
    asset_address: address || null,
    chain: chain || null,
    usd,
    pct_of_parent: pct ?? null,
    source: 'onchain',
    confidence: 'high',
  };
}

function unknownRow({ usd, reason, protocol, chain }) {
  return {
    kind: 'unknown',
    venue: protocol || null,
    chain: chain || null,
    usd,
    source: 'manual',
    confidence: 'low',
    evidence: { reason: reason || 'no adapter registered' },
  };
}

module.exports = { validateRow, opaqueRow, primaryAssetRow, unknownRow, ROW_KINDS, ROW_SOURCES, CONFIDENCES };
