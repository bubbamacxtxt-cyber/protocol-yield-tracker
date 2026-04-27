/**
 * Curve LP adapter.
 *
 * A Curve LP share is a pro-rata claim on every token in the pool. We already
 * have scanner output in `position_tokens` with role='supply' split across
 * each underlying. So we can emit lp_underlying rows directly from that,
 * with high confidence (scanner writes scaled USD per leg).
 */

module.exports = {
  id: 'curve',
  protocol_names: ['Curve'],
  protocol_canonicals: ['curve'],
  confidence: 'high',
  references: ['https://curve.fi/'],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const total = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;
    if (!tokens.length) {
      return [{
        kind: 'lp_underlying',
        venue: 'Curve',
        chain: position.chain,
        usd: position.net_usd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'Curve LP with no per-leg scanner output' },
      }];
    }
    return tokens.map(t => ({
      kind: 'lp_underlying',
      venue: 'Curve',
      chain: position.chain,
      asset_symbol: t.real_symbol || t.symbol,
      asset_address: t.address,
      usd: t.value_usd || 0,
      pct_of_parent: total > 0 ? ((t.value_usd || 0) / total) * 100 : null,
      source: 'onchain',
      confidence: 'high',
      evidence: { curve_leg: true },
    }));
  },
};
