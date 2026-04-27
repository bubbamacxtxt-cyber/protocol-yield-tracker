/**
 * Compound V3 (Comet) adapter.
 *
 * Each Comet market has one base asset (borrow) and N accepted collaterals.
 * As a supplier of the base asset, your secondary risk is all the collaterals
 * accepted by that Comet.
 *
 * v1: shallow pool_share. v2 will enumerate accepted collaterals via
 * getAssetInfo() on the Comet contract and emit market_exposure children.
 */

module.exports = {
  id: 'compound',
  protocol_names: ['Compound'],
  protocol_canonicals: ['compound', 'compound-v3', 'compound3'],
  confidence: 'medium',
  references: ['https://docs.compound.finance/'],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const total = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;
    if (!tokens.length) {
      return [{
        kind: 'pool_share',
        venue: 'Compound V3',
        chain: position.chain,
        usd: position.net_usd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'Compound adapter v1; getAssetInfo decomposition TODO' },
      }];
    }
    return tokens.map(t => ({
      kind: 'pool_share',
      venue: 'Compound V3',
      chain: position.chain,
      asset_symbol: t.real_symbol || t.symbol,
      asset_address: t.address,
      usd: t.value_usd || 0,
      pct_of_parent: total > 0 ? ((t.value_usd || 0) / total) * 100 : null,
      source: 'onchain',
      confidence: 'medium',
      evidence: { shallow: true, reason: 'Compound adapter v1; getAssetInfo decomposition TODO' },
    }));
  },
};
