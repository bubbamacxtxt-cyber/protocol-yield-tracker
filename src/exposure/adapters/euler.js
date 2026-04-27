/**
 * Euler v2 (EVK) adapter.
 *
 * Euler uses the cluster model: each "cluster" has a loan vault plus N
 * collateral vaults. A supplier's secondary exposure is to all collateral
 * vaults in the same cluster pro-rata to their share of the loan vault's
 * totalAssets. Reservoir-monitor demonstrates the pattern with on-chain
 * borrower cross-referencing → a `borrowBreakdown` per cluster.
 *
 * v1 (this file): shallow pool_share with the supplied asset. Deep lens will
 * use Goldsky to enumerate (account, vault) rows for the cluster and
 * aggregate collateral mix per borrower, then apply user share.
 */

module.exports = {
  id: 'euler',
  protocol_names: ['Euler'],
  protocol_canonicals: ['euler', 'euler-v2'],
  confidence: 'medium',
  references: [
    'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/',
    'https://app.euler.finance/',
  ],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const total = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;
    if (!tokens.length) {
      return [{
        kind: 'pool_share',
        venue: 'Euler',
        chain: position.chain,
        usd: position.net_usd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'Euler adapter v1; cluster borrowBreakdown TODO' },
      }];
    }
    return tokens.map(t => ({
      kind: 'pool_share',
      venue: 'Euler',
      chain: position.chain,
      asset_symbol: t.real_symbol || t.symbol,
      asset_address: t.address,
      usd: t.value_usd || 0,
      pct_of_parent: total > 0 ? ((t.value_usd || 0) / total) * 100 : null,
      source: 'onchain',
      confidence: 'medium',
      evidence: { shallow: true, reason: 'Euler adapter v1; cluster borrowBreakdown TODO' },
    }));
  },
};
