/**
 * Pendle adapter.
 *
 * PT  — redeems 1:1 to SY at maturity. Exposure = SY underlying.
 * YT  — claim on yield of SY. Exposure = SY underlying but labeled yield_only.
 * LP  — PT + SY pair. Split by pool reserves when scanner provides legs.
 *
 * Pendle fallback rows (protocol_id='pendle2' etc.) are already flagged
 * unresolved upstream; we emit a shallow unknown-ish row for them so they're
 * visible in the audit as "pendle position needing resolution".
 *
 * v1: use scanner-provided supply tokens as the exposure. If the supply
 * token is itself a known YBS (sUSDe, sUSDS, stcUSD, etc.), we mark it so
 * a future recursion pass can decompose it further.
 */

const YBS_TOKENS_BY_SYMBOL = new Set([
  'susde', 'usde', 'susds', 'susdc', 'stcusd', 'yousd', 'iusd', 'susdai',
]);

function isYbsSymbol(sym) {
  return sym && YBS_TOKENS_BY_SYMBOL.has(String(sym).toLowerCase());
}

module.exports = {
  id: 'pendle',
  protocol_names: ['Pendle', 'Pendle Fallback'],
  protocol_canonicals: ['pendle'],
  confidence: 'medium',
  references: ['https://app.pendle.finance/'],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const total = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;

    const strategy = String(position.strategy || '').toLowerCase();
    const yieldOnly = strategy.includes('yt') || strategy.includes('yield');

    if (!tokens.length) {
      return [{
        kind: 'pendle_underlying',
        venue: position.protocol_name,
        chain: position.chain,
        usd: position.net_usd,
        source: 'subgraph',
        confidence: 'low',
        evidence: { shallow: true, reason: 'pendle position has no supply tokens', yield_only: yieldOnly, strategy },
      }];
    }

    return tokens.map(t => {
      const sym = t.real_symbol || t.symbol;
      return {
        kind: 'pendle_underlying',
        venue: position.protocol_name,
        chain: position.chain,
        asset_symbol: sym,
        asset_address: t.address,
        usd: t.value_usd || 0,
        pct_of_parent: total > 0 ? ((t.value_usd || 0) / total) * 100 : null,
        source: 'subgraph',
        confidence: 'medium',
        evidence: {
          strategy,
          yield_only: yieldOnly,
          recurses_to_ybs: isYbsSymbol(sym),
        },
      };
    });
  },
};
