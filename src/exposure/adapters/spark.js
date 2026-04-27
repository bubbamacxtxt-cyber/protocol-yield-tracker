/**
 * Spark adapter.
 *
 * Spark Lend is an Aave-v2/v3 fork. Its deposit-side exposure model is
 * identical to Aave (shared pool, many reserves). For now we emit a shallow
 * pool_share row referencing the Spark pool — a real Spark adapter that
 * queries their subgraph for reserves would drop in the same structure as
 * aave.js. Spark Savings (sUSDS, sUSDC) are handled via sky.js / direct
 * supply — the spark-scanner already disambiguates.
 */

module.exports = {
  id: 'spark',
  protocol_names: ['Spark', 'sGHO'],
  protocol_canonicals: ['spark'],
  confidence: 'medium',
  references: [
    'https://api.spark.fi/',
    'https://docs.spark.fi/',
  ],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const total = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;
    if (!tokens.length) {
      return [{
        kind: 'pool_share',
        venue: 'Spark',
        chain: position.chain,
        usd: position.net_usd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'Spark adapter v1; reserve-list decomposition TODO' },
      }];
    }
    return tokens.map(t => ({
      kind: 'pool_share',
      venue: 'Spark',
      chain: position.chain,
      asset_symbol: t.real_symbol || t.symbol,
      asset_address: t.address,
      usd: t.value_usd || 0,
      pct_of_parent: total > 0 ? ((t.value_usd || 0) / total) * 100 : null,
      source: 'onchain',
      confidence: 'medium',
      evidence: { shallow: true, reason: 'Spark adapter v1; reserve-list decomposition TODO' },
    }));
  },
};
