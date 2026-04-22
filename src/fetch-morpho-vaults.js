#!/usr/bin/env node
/**
 * Fetch Morpho MetaMorpho vault list.
 *
 * Output: data/morpho-vaults.json
 *
 * Purpose:
 *   Token discovery (Layer 2) uses this list to SKIP tokens that are
 *   Morpho vault shares. Those positions are authoritative under the
 *   Morpho scanner which resolves shares -> underlying USD correctly.
 *   Without this skip, wallet-held steakUSDC + Morpho position row
 *   double-count.
 *
 * Per docs/TOKEN-RULES.md: Morpho is a protocol scanner. Its output is
 * authoritative for Morpho positions. Vault shares do not belong in
 * wallet-held OR the vault list.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'morpho-vaults.json');

const CHAIN_MAP = {
  1: 'eth', 8453: 'base', 42161: 'arb', 137: 'poly', 10: 'opt',
  130: 'uni', 143: 'monad', 999: 'ink', 747474: 'wct',
  5000: 'mnt', 81457: 'blast', 534352: 'scroll',
  9745: 'plasma', 56: 'bsc',
};

async function fetchVaultsForChain(chainId) {
  const query = `{
    vaults(first: 1000, where: { chainId_in: [${chainId}] }) {
      items {
        address
        symbol
        whitelisted
        chain { id }
        asset { symbol }
        state { totalAssetsUsd }
      }
    }
  }`;
  const r = await fetch('https://api.morpho.org/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = await r.json();
  return data?.data?.vaults?.items || [];
}

async function main() {
  // Fetch ALL vaults per chain (whitelisted + non-whitelisted Gauntlet/custom).
  // GraphQL's global first:1000 caps at 989; per-chain gets us the full set.
  const chains = Object.keys(CHAIN_MAP).map(Number);
  const vaults = [];
  for (const cid of chains) {
    const items = await fetchVaultsForChain(cid);
    if (items.length > 0) {
      console.log(`  chain ${cid}: ${items.length} vaults`);
      vaults.push(...items);
    }
  }

  // Dedupe by (chain, address)
  const uniq = new Map();
  for (const v of vaults) {
    const key = `${v.chain?.id}:${v.address.toLowerCase()}`;
    if (!uniq.has(key)) uniq.set(key, v);
  }

  const output = {
    fetched_at: new Date().toISOString(),
    count: uniq.size,
    vaults: Array.from(uniq.values()).map(v => ({
      protocol: 'Morpho',
      symbol: v.symbol || '?',
      whitelisted: v.whitelisted ?? null,
      chain: CHAIN_MAP[v.chain?.id] || String(v.chain?.id || 'unknown'),
      chain_id: v.chain?.id,
      address: v.address.toLowerCase(),
      underlying_symbol: v.asset?.symbol || null,
      tvl_usd: v.state?.totalAssetsUsd || 0,
    })),
  };

  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUT}`);
  console.log(`Morpho vaults: ${vaults.length}`);

  // Quick chain breakdown
  const byChain = {};
  for (const v of output.vaults) byChain[v.chain] = (byChain[v.chain] || 0) + 1;
  for (const [c, n] of Object.entries(byChain).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(6)} ${n}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
