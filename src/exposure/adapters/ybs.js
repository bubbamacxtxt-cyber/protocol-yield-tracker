/**
 * Generic Yield-Bearing Stable adapter.
 *
 * Covers: yoUSD, Cap stcUSD, Ethena USDe/sUSDe, InfiniFi iUSD/fUSDnr, Sky sUSDS,
 * usd-ai sUSDai, Yuzu yzUSDUSDT0 — any protocol whose primary output is a
 * single ERC-20 token backed by a mix of underlying strategies.
 *
 * Strategy per YBS:
 *   1. Try protocol-specific backing endpoint (one per token).
 *   2. If endpoint unavailable, fall back to ybs_backing_cache (last-known).
 *   3. If no cache either, emit a single pool_share row with medium confidence
 *      and `evidence.reason='ybs backing feed missing'` so audit flags it.
 *
 * Backing endpoints are registered in a table below. Adding a new YBS =
 * adding one entry + a fetcher function.
 */

const { opaqueRow } = require('./_base');

// Fetcher registry. Each fetcher returns:
//   { as_of, composition: [{ venue, asset, usd, pct }] }  (pct sums to 100)
// or null to trigger cache fallback.

async function fetchJson(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'accept': 'application/json' }, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

const BACKING_FETCHERS = {
  // Ethena reserve fund — public solvency endpoint
  ethena: async () => {
    const j = await fetchJson('https://app.ethena.fi/api/solvency');
    if (!j) return null;
    // Response shape: { totalValue, breakdown: [{ name, usd, pct }] }
    const breakdown = Array.isArray(j.breakdown) ? j.breakdown : null;
    if (!breakdown) return null;
    return {
      as_of: j.as_of || j.timestamp || new Date().toISOString(),
      composition: breakdown.map(b => ({
        venue: b.name || b.venue,
        asset: b.asset || b.symbol || b.name,
        usd: Number(b.usd || b.value || 0),
        pct: Number(b.pct || 0),
      })),
    };
  },

  // InfiniFi allocation — their internal API; format approximated until we
  // verify live payload. Falls back cleanly if 404.
  infinifi: async () => {
    const j = await fetchJson('https://www.infinifi.xyz/api/reserves');
    if (!j) return null;
    const items = Array.isArray(j.allocations) ? j.allocations : Array.isArray(j) ? j : null;
    if (!items) return null;
    const total = items.reduce((s, i) => s + Number(i.usd || i.tvl || 0), 0);
    return {
      as_of: j.as_of || new Date().toISOString(),
      composition: items.map(i => ({
        venue: i.venue || i.protocol || i.name,
        asset: i.asset || i.symbol,
        usd: Number(i.usd || i.tvl || 0),
        pct: total > 0 ? (Number(i.usd || i.tvl || 0) / total) * 100 : 0,
      })),
    };
  },

  // yoUSD — public vault API
  yousd: async () => {
    const j = await fetchJson('https://app.yo.xyz/api/vaults/yousd');
    if (!j) return null;
    const strategies = Array.isArray(j.strategies) ? j.strategies : null;
    if (!strategies) return null;
    const total = strategies.reduce((s, x) => s + Number(x.tvl_usd || x.usd || 0), 0);
    return {
      as_of: j.as_of || new Date().toISOString(),
      composition: strategies.map(s => ({
        venue: s.name || s.protocol,
        asset: s.asset || 'USDC',
        usd: Number(s.tvl_usd || s.usd || 0),
        pct: total > 0 ? (Number(s.tvl_usd || s.usd || 0) / total) * 100 : 0,
      })),
    };
  },

  // Placeholder fetchers for ones where we don't yet have the backing API URL.
  // Each one returns null → falls back to ybs_backing_cache or emits a
  // single-row decomposition marked low confidence.
  cap: async () => null,
  sky: async () => null,
  usdai: async () => null,
  yuzu: async () => null,
};

const PROTOCOL_MAP = [
  // [ regex on protocol_name, fetcher key, token_symbol_expected ]
  { re: /^yoUSD$/i,                 fetcher: 'yousd',   label: 'yoUSD' },
  { re: /^Cap stcUSD$|^cap$/i,      fetcher: 'cap',     label: 'Cap stcUSD' },
  { re: /^ethena/i,                 fetcher: 'ethena',  label: 'Ethena' },
  { re: /^infinifi/i,               fetcher: 'infinifi',label: 'InfiniFi' },
  { re: /^Sky$/i,                   fetcher: 'sky',     label: 'Sky sUSDS' },
  { re: /^usd-ai$/i,                fetcher: 'usdai',   label: 'usd-ai' },
  { re: /^Yuzu Money$|^yzUSDUSDT0$/i, fetcher: 'yuzu',  label: 'Yuzu' },
];

function matchProtocol(pname) {
  return PROTOCOL_MAP.find(m => m.re.test(pname)) || null;
}

async function loadFromCache(db, tokenAddress, chain) {
  if (!tokenAddress) return null;
  const row = db.prepare('SELECT composition_json, fetched_at FROM ybs_backing_cache WHERE token_address = ? AND chain = ?')
    .get(String(tokenAddress).toLowerCase(), chain);
  if (!row) return null;
  try {
    return { as_of: row.fetched_at, composition: JSON.parse(row.composition_json), cached: true };
  } catch { return null; }
}

function saveToCache(db, tokenAddress, chain, backing) {
  if (!tokenAddress || !backing) return;
  db.prepare(`INSERT INTO ybs_backing_cache (token_address, chain, composition_json, fetched_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(token_address, chain) DO UPDATE SET
              composition_json = excluded.composition_json,
              fetched_at = excluded.fetched_at`)
    .run(String(tokenAddress).toLowerCase(), chain, JSON.stringify(backing.composition), backing.as_of);
}

module.exports = {
  id: 'ybs',
  protocol_names: [
    'yoUSD', 'Cap stcUSD', 'cap', 'ethena-usde', 'infinifi', 'infinifiUSD Autopool',
    'Sky', 'usd-ai', 'Yuzu Money', 'yzUSDUSDT0',
  ],
  confidence: 'high',
  references: [
    'https://app.ethena.fi/api/solvency',
    'https://app.yo.xyz/api/vaults/yousd',
    'https://www.infinifi.xyz/api/reserves',
  ],
  async compute(position, ctx) {
    const match = matchProtocol(position.protocol_name);
    const fetcherKey = match?.fetcher;
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const primaryToken = tokens[0] || null;

    let backing = null;
    let source = 'protocol-api';
    let confidence = 'high';

    if (fetcherKey && BACKING_FETCHERS[fetcherKey]) {
      const cacheKey = `ybs:${fetcherKey}`;
      backing = ctx.cache.get(cacheKey);
      if (!backing) {
        try {
          backing = await BACKING_FETCHERS[fetcherKey]();
          if (backing) ctx.cache.set(cacheKey, backing);
        } catch {}
      }
    }

    if (!backing && primaryToken?.address) {
      backing = await loadFromCache(ctx.db, primaryToken.address, position.chain);
      if (backing) { source = 'cached'; confidence = 'medium'; }
    }

    if (backing && backing.composition?.length) {
      if (primaryToken?.address && source !== 'cached') {
        try { saveToCache(ctx.db, primaryToken.address, position.chain, backing); } catch {}
      }
      const userUsd = position.net_usd;
      return [{
        kind: 'ybs_strategy',
        venue: match?.label || position.protocol_name,
        asset_symbol: primaryToken?.real_symbol || primaryToken?.symbol,
        asset_address: primaryToken?.address,
        chain: position.chain,
        usd: userUsd,
        source,
        confidence,
        as_of: backing.as_of,
        evidence: { backing_fetcher: fetcherKey, leg_count: backing.composition.length },
        children: backing.composition.map(b => ({
          kind: 'ybs_strategy',
          venue: b.venue || 'strategy',
          asset_symbol: b.asset,
          usd: userUsd * (b.pct || 0) / 100,
          pct_of_parent: b.pct || null,
          source,
          confidence,
          as_of: backing.as_of,
          evidence: { raw_usd_in_backing: b.usd },
        })),
      }];
    }

    // No backing data — emit a single pool_share with low/medium confidence
    // so the audit sees this as "known YBS, backing feed missing".
    return [{
      kind: 'pool_share',
      venue: match?.label || position.protocol_name,
      asset_symbol: primaryToken?.real_symbol || primaryToken?.symbol || position.protocol_name,
      asset_address: primaryToken?.address,
      chain: position.chain,
      usd: position.net_usd,
      source: fetcherKey ? 'protocol-api' : 'manual',
      confidence: fetcherKey ? 'low' : 'medium',
      evidence: {
        shallow: true,
        reason: fetcherKey ? 'ybs backing feed returned null' : 'no backing fetcher registered for this YBS',
        fetcher: fetcherKey,
      },
    }];
  },
};
