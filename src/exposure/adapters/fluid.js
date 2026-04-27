/**
 * Fluid adapter.
 *
 * Fluid has two product shapes in our scanner:
 *  - Lending (fluid-lending tokens): share of a pool, shallow for now.
 *  - Vault NFTs (single-collateral/single-debt position): already isolated.
 *
 * Data source: Fluid REST (api.fluid.instadapp.io/v2/lending/{chainId}/tokens)
 * already used by fluid-scanner. For now we emit a pool_share with the
 * supplied asset so the $11M is covered; deep reserve enumeration is a small
 * follow-up (it's one REST call per chain and the response already has
 * supplyRate/borrowRate/totalSupply/totalBorrow per asset).
 */

module.exports = {
  id: 'fluid',
  protocol_names: ['Fluid'],
  protocol_canonicals: ['fluid', 'fluid-lending'],
  confidence: 'medium',
  references: ['https://api.fluid.instadapp.io/v2/lending/'],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const total = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;
    if (!tokens.length) {
      return [{
        kind: 'pool_share',
        venue: 'Fluid',
        chain: position.chain,
        usd: position.net_usd,
        source: 'protocol-api',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'Fluid adapter v1; reserve-list decomposition TODO' },
      }];
    }
    return tokens.map(t => ({
      kind: 'pool_share',
      venue: 'Fluid',
      chain: position.chain,
      asset_symbol: t.real_symbol || t.symbol,
      asset_address: t.address,
      usd: t.value_usd || 0,
      pct_of_parent: total > 0 ? ((t.value_usd || 0) / total) * 100 : null,
      source: 'protocol-api',
      confidence: 'medium',
      evidence: { shallow: true, reason: 'Fluid adapter v1; reserve-list decomposition TODO' },
    }));
  },
};
