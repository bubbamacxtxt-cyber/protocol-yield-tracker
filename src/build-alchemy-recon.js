#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { fetchJSON } = require('./fetch-helper');

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
if (!ALCHEMY_KEY) {
  console.error('Missing ALCHEMY_API_KEY');
  process.exit(1);
}

const RECON = path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-summary.json');
const OUT = path.join(__dirname, '..', 'data', 'recon', 'alchemy-token-discovery.json');

const RPCS = {
  eth: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  arb: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  base: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  mnt: process.env.ALCHEMY_MNT_RPC_URL || '',
  plasma: process.env.ALCHEMY_PLASMA_RPC_URL || '',
  monad: process.env.ALCHEMY_MONAD_RPC_URL || '',
  sonic: process.env.ALCHEMY_SONIC_RPC_URL || '',
  ink: process.env.ALCHEMY_INK_RPC_URL || '',
};

async function rpc(url, method, params) {
  if (!url) return null;
  const res = await fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  }, 2);
  return res?.result || null;
}

async function main() {
  const recon = JSON.parse(fs.readFileSync(RECON, 'utf8'));
  const wallets = [];
  for (const w of (recon.wallets || [])) {
    for (const c of (w.chains || [])) {
      if (!c.active_for_position_scan) continue;
      if (!RPCS[c.chain]) continue;
      wallets.push({ whale: w.whale, wallet: w.wallet, chain: c.chain, total_usd: c.total_usd });
    }
  }

  const out = [];
  for (const w of wallets) {
    const result = await rpc(RPCS[w.chain], 'alchemy_getTokenBalances', [w.wallet]);
    const tokenBalances = (result?.tokenBalances || []).filter(t => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x0000000000000000000000000000000000000000000000000000000000000000');
    out.push({ whale: w.whale, wallet: w.wallet, chain: w.chain, total_usd: w.total_usd, tokens: tokenBalances.map(t => ({ address: t.contractAddress.toLowerCase(), tokenBalance: t.tokenBalance })) });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), wallets: out }, null, 2));
  console.log(`Wrote ${OUT}`);
  console.log(`Wallet-chain scans: ${out.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
