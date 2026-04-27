/**
 * Single-venue placeholder adapter.
 *
 * For protocols where we track the deposit but haven't yet written a proper
 * lookthrough (Dolomite, Gearbox, Curvance, Venus Flux, LFJ, STRATEGY, etc.),
 * we emit one `pool_share` row with medium confidence so coverage gets
 * credit but the audit page can see these are shallow decompositions.
 *
 * Upgrade path: each of these should get its own dedicated adapter file with
 * real on-chain / subgraph / API decomposition. Until then this gives us an
 * honest, non-zero, but explicitly-shallow answer.
 *
 * See docs/secondary-risk-coverage-plan.md §3.8.
 */

module.exports = {
  id: 'single-venue',
  protocol_names: [
    'Dolomite', 'Gearbox', 'Curvance', 'Venus Flux', 'LFJ', 'STRATEGY',
    'Yuzu Money', 'yzUSDUSDT0', 'usd-ai',
  ],
  confidence: 'medium',
  references: [
    'https://docs.dolomite.io/',
    'https://docs.gearbox.fi/',
    'https://docs.venus.io/',
  ],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const totalSupply = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;
    if (!tokens.length) {
      return [{
        kind: 'pool_share',
        venue: position.protocol_name,
        chain: position.chain,
        asset_symbol: position.yield_source || position.protocol_name,
        usd: position.net_usd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'single-venue placeholder; deep adapter TODO' },
      }];
    }
    return tokens.map(t => ({
      kind: 'pool_share',
      venue: position.protocol_name,
      chain: position.chain,
      asset_symbol: t.real_symbol || t.symbol,
      asset_address: t.address,
      usd: t.value_usd || 0,
      pct_of_parent: totalSupply > 0 ? ((t.value_usd || 0) / totalSupply) * 100 : null,
      source: 'onchain',
      confidence: 'medium',
      evidence: { shallow: true, reason: 'single-venue placeholder; deep adapter TODO' },
    }));
  },
};
