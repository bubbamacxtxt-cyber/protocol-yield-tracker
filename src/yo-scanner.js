#!/usr/bin/env node
/**
 * YO Protocol Scanner
 *
 * YO Protocol (app.yo.xyz) is a multi-chain yield optimizer with 4 vaults
 * (USD, ETH, BTC, EURC) deployed on Ethereum, Base, and Arbitrum. Each
 * vault is an ERC-4626 that holds underlying assets and deploys them
 * into other protocols (Morpho, Aave, Euler, Fluid, etc.) via strategy
 * modules. DefiLlama TVL ≈ sum of totalAssets() across all vaults.
 *
 * Our ordinary wallet scanner treats `0x0000000f2eb9f6...` (yoUSD) as
 * a user wallet and only captures tokens it directly holds + Morpho
 * earn positions it has opened. That misses the bulk of the TVL because
 * most assets are deployed via AlchemistCS (internal) or non-Morpho paths.
 *
 * Correct approach: directly call totalAssets() on each YO vault and
 * record as a single protocol-api position per vault per chain.
 *
 * Source: https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/yo/index.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

const RPCS = {
  eth: 'https://eth-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
  base: 'https://base-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
  arb: 'https://arb-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
};

// Only yoUSD for now. Other YO vaults (yoETH, yoBTC, yoEURC, yoGOLD) are
// documented in defillama/projects/yo/index.js and can be re-enabled if
// we want to track them as separate whales later.
const VAULTS = {
  eth: [
    { address: '0x0000000f2eB9f69274678c76222B35eEc7588a65', name: 'yoUSD' },
  ],
  base: [
    { address: '0x0000000f2eB9f69274678c76222B35eEc7588a65', name: 'yoUSD' },
  ],
  arb: [],
};

// Canonical price sources. Keep minimal and use on-chain data where possible.
// For simplicity we use CoinGecko simple-price for underlying tokens by id.
async function getPrices() {
  const ids = 'usd-coin,ethereum,bitcoin,euro-coin,pax-gold,tether-gold';
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const d = await r.json();
    const gold = d['tether-gold']?.usd || d['pax-gold']?.usd || 3300;
    return {
      USDC: d['usd-coin']?.usd || 1,
      WETH: d.ethereum?.usd || 3000,
      WBTC: d.bitcoin?.usd || 90000,
      cbBTC: d.bitcoin?.usd || 90000,
      EURC: d['euro-coin']?.usd || 1.1,
      PAXG: d['pax-gold']?.usd || 3300,
      XAUt: gold,
    };
  } catch (e) {
    console.log('price fetch failed, using fallback defaults');
    return { USDC: 1, WETH: 3000, WBTC: 90000, cbBTC: 90000, EURC: 1.1, PAXG: 3300, XAUt: 3300 };
  }
}

async function rpcCall(url, to, data) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const d = await r.json();
  return d.result;
}

async function scanVault(chain, vault, prices) {
  const url = RPCS[chain];
  const addr = vault.address;

  // totalAssets() selector 0x01e1d114
  const taHex = await rpcCall(url, addr, '0x01e1d114');
  if (!taHex || taHex === '0x') return null;
  const totalAssets = BigInt(taHex);
  if (totalAssets === 0n) return null;

  // asset()
  const assetHex = await rpcCall(url, addr, '0x38d52e0f');
  const underlying = '0x' + (assetHex || '').slice(-40).toLowerCase();
  if (!underlying || underlying === '0x') return null;

  // decimals() and symbol() on underlying
  const [decHex, symHex] = await Promise.all([
    rpcCall(url, underlying, '0x313ce567'),
    rpcCall(url, underlying, '0x95d89b41'),
  ]);
  const decimals = parseInt(decHex || '0x12', 16);
  // Parse ABI-encoded string for symbol (offset 0x20 + length + data)
  let symbol = '?';
  try {
    if (symHex && symHex.length > 130) {
      const len = parseInt(symHex.slice(66, 130), 16);
      const hex = symHex.slice(130, 130 + len * 2);
      symbol = Buffer.from(hex, 'hex').toString('utf8').trim();
    }
  } catch (e) {}

  const amount = Number(totalAssets) / (10 ** decimals);
  const price = prices[symbol] || (symbol.startsWith('y') ? 1 : 0);
  const valueUsd = amount * price;

  return {
    vault_address: addr.toLowerCase(),
    vault_name: vault.name,
    chain,
    underlying_address: underlying,
    underlying_symbol: symbol,
    amount,
    price,
    value_usd: valueUsd,
  };
}

function savePositions(db, results) {
  // yoUSD vault address is the single whale wallet we track. One
  // yo-protocol position per chain, with totalAssets() as its value.

  // Clean all existing YO-protocol rows first (FK-safe order)
  const oldIds = db.prepare(`SELECT id FROM positions WHERE protocol_id = 'yo-protocol'`).all();
  const delTok = db.prepare(`DELETE FROM position_tokens WHERE position_id = ?`);
  const delMkt = db.prepare(`DELETE FROM position_markets WHERE position_id = ?`);
  const delPos = db.prepare(`DELETE FROM positions WHERE id = ?`);
  for (const r of oldIds) { delTok.run(r.id); delMkt.run(r.id); delPos.run(r.id); }

  // position_type 'Vault' (not 'Lending') because yoUSD is an aggregator vault
  // that deploys USDC into Morpho/Aave/Euler strategies. Calling it "Lend" in
  // the UI is misleading — the protocol isn't supplying USDC to itself.
  const upsertPos = db.prepare(`
    INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, net_usd, asset_usd, debt_usd, position_index, scanned_at)
    VALUES (?, ?, 'yo-protocol', 'yoUSD', 'Vault', 'vault', ?, ?, 0, ?, datetime('now'))
    ON CONFLICT(wallet, chain, protocol_id, position_index) DO UPDATE SET
      position_type = 'Vault', strategy = 'vault',
      net_usd = excluded.net_usd, asset_usd = excluded.asset_usd, scanned_at = datetime('now')
  `);
  const findPos = db.prepare(`SELECT id FROM positions WHERE lower(wallet) = ? AND chain = ? AND protocol_id = 'yo-protocol' AND position_index = ?`);
  const insertToken = db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, value_usd, apy_base, bonus_supply_apy)
    VALUES (?, 'supply', ?, ?, ?, ?, NULL, NULL)
  `);

  for (const r of results) {
    const wallet = r.vault_address.toLowerCase();
    const idx = `${r.chain}|${r.vault_name}|totalAssets`;
    upsertPos.run(wallet, r.chain, r.value_usd, r.value_usd, idx);
    const pos = findPos.get(wallet, r.chain, idx);
    if (pos?.id) {
      insertToken.run(pos.id, r.underlying_symbol, r.underlying_address, r.amount, r.value_usd);
    }
  }
}

async function main() {
  console.log('=== YO Protocol Scanner ===');
  const prices = await getPrices();
  console.log('Prices:', prices);

  const results = [];
  for (const [chain, vaults] of Object.entries(VAULTS)) {
    if (!vaults.length) continue;
    console.log(`\n[${chain}]`);
    for (const v of vaults) {
      try {
        const r = await scanVault(chain, v, prices);
        if (r && r.value_usd > 0) {
          console.log(`  ${v.name.padEnd(8)} ${r.amount.toFixed(4)} ${r.underlying_symbol} = $${(r.value_usd/1e6).toFixed(2)}M`);
          results.push(r);
        } else {
          console.log(`  ${v.name.padEnd(8)} (empty or missing)`);
        }
      } catch (e) {
        console.log(`  ${v.name} ERR: ${e.message}`);
      }
    }
  }

  const total = results.reduce((s, r) => s + r.value_usd, 0);
  console.log(`\n=== Total YO TVL: $${(total/1e6).toFixed(2)}M ===`);

  const db = new Database(DB_PATH);
  savePositions(db, results);
  db.close();
  console.log(`Saved ${results.length} positions for 0x0000000f... yo-protocol`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { scanVault, savePositions };
