#!/usr/bin/env node
/**
 * Aave decomposition helper
 *
 * Use DeBank protocol item splits as a decomposition hint when the public Aave GraphQL only provides
 * aggregate wallet+chain exposure. This is an inference layer, not venue discovery.
 */
const fs = require('fs');
const path = require('path');

const DEBANK_RECON = path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-positions.json');

function loadRecon() {
  try { return JSON.parse(fs.readFileSync(DEBANK_RECON, 'utf8')).positions || []; } catch { return []; }
}

function normalizeSymbol(sym) {
  return String(sym || '').replace('USD₮0', 'USDT0');
}

function decomposeAaveFromDebank(wallet, chain, aggregateRow) {
  const recon = loadRecon();
  const items = recon.filter(p =>
    String(p.wallet || '').toLowerCase() === String(wallet || '').toLowerCase()
    && String(p.chain || '').toLowerCase() === String(chain || '').toLowerCase()
    && String(p.protocol_id || '').toLowerCase().includes('aave')
  );
  if (!items.length) return [aggregateRow];

  const out = [];
  for (const item of items) {
    const raw = item.raw || {};
    const portfolio = Array.isArray(raw.portfolio_item_list) ? raw.portfolio_item_list : [];
    for (const pi of portfolio) {
      const stats = pi.stats || {};
      const assets = Array.isArray(pi.asset_token_list) ? pi.asset_token_list : [];
      const assetTokens = assets.filter(t => (t.amount || 0) > 0);
      if (!assetTokens.length) continue;
      const supplied = assetTokens.filter(t => !(t.protocol_id || '').includes('gho') && !(t.protocol_id || '').includes('usdt') && !(t.protocol_id || '').includes('usdc'));
      const borrowed = assetTokens.filter(t => ['USDT','USDT0','USDC','USD₮0'].includes(normalizeSymbol(t.symbol)) && (stats.debt_usd_value || 0) > 0);
      const supplySyms = (supplied.length ? supplied : assetTokens.filter(t => (stats.asset_usd_value || 0) > 0)).map(t => normalizeSymbol(t.symbol));
      const borrowSyms = borrowed.map(t => normalizeSymbol(t.symbol));
      out.push({
        ...aggregateRow,
        position_index: `${wallet.toLowerCase()}|${chain}|debank-split|${supplySyms.join('-') || 'supply'}|${borrowSyms.join('-') || 'noborrow'}|${Math.round((stats.net_usd_value || 0))}`,
        net_usd: Number(stats.net_usd_value || 0),
        asset_usd: Number(stats.asset_usd_value || aggregateRow.asset_usd || 0),
        debt_usd: Number(stats.debt_usd_value || 0),
        supply: [{ symbol: supplySyms.join(', ') || aggregateRow.supply?.[0]?.symbol || '?', address: aggregateRow.supply?.[0]?.address || '', value_usd: Number(stats.asset_usd_value || aggregateRow.asset_usd || 0), apy_base: aggregateRow.apy_base, bonus_supply_apy: aggregateRow.bonus_supply || null }],
        borrow: borrowSyms.length ? [{ symbol: borrowSyms.join(', '), address: aggregateRow.borrow?.[0]?.address || '', value_usd: Number(stats.debt_usd_value || 0), apy_base: aggregateRow.apy_cost || null }] : [],
      });
    }
  }
  return out.length ? out : [aggregateRow];
}

module.exports = { decomposeAaveFromDebank };
