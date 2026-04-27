/**
 * Wallet holds adapter.
 *
 * A plain token sitting in a wallet is a primary exposure to that token. If
 * it's a yield-bearing stable (sUSDe, sUSDS, stcUSD, etc.), the orchestrator
 * will (in future) let us recurse via a companion YBS adapter. For now we
 * emit the top-level token exposure; the YBS recursion layer can attach
 * children later using this row's asset_address.
 */

const { primaryAssetRow } = require('./_base');

module.exports = {
  id: 'wallet',
  protocol_names: ['Wallet'],
  protocol_canonicals: ['wallet', 'wallet-held'],
  confidence: 'high',
  references: [],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => (t.role === 'supply'));
    if (!tokens.length) {
      return [primaryAssetRow({
        symbol: position.yield_source || position.protocol_name,
        chain: position.chain,
        usd: position.net_usd,
      })];
    }
    const total = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;
    return tokens.map(t => primaryAssetRow({
      symbol: t.real_symbol || t.symbol,
      address: t.address,
      chain: position.chain,
      usd: t.value_usd || 0,
      pct: total > 0 ? ((t.value_usd || 0) / total) * 100 : null,
    }));
  },
};
