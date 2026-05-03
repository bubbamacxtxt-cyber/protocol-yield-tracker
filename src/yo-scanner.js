#!/usr/bin/env node
/**
 * YO Protocol Scanner
 *
 * Emits one yo-protocol row per chain reflecting the vault's totalAssets().
 * The protocol_name is "yoUSD" — that triggers the YBS exposure adapter
 * (src/exposure/adapters/ybs.js) which pulls the underlying allocation
 * from DeFiLlama and writes the secondary-risk decomposition (showing
 * Morpho cbBTC/USDC, WETH/USDC, wstETH/USDT, idle USDC, etc.).
 *
 * Position type 'Vault' (not 'Lending') because yoUSD is an aggregator
 * that deploys USDC into other protocols — calling it "Lend" misleadingly
 * looked like yoUSD supplying USDC to itself.
 *
 * NOTE: The morpho-scanner ALSO finds yoUSD's Morpho deposits because the
 * vault's wallet (0x0000000f2eB9...) IS the address holding them. To avoid
 * double-counting, the cross-source dedup in export.js suppresses one or
 * the other. Keeping the yoUSD-named row preserves YBS lookthrough.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

const RPCS = {
  eth: 'https://eth-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
  base: 'https://base-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
};

const VAULTS = {
  eth: [{ address: '0x0000000f2eB9f69274678c76222B35eEc7588a65', name: 'yoUSD' }],
  base: [{ address: '0x0000000f2eB9f69274678c76222B35eEc7588a65', name: 'yoUSD' }],
};

async function rpcCall(url, to, data) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  return (await r.json()).result;
}

function decodeStr(hex) {
  if (!hex || hex.length < 130) return null;
  const len = parseInt(hex.slice(66, 130), 16);
  return Buffer.from(hex.slice(130, 130 + len * 2), 'hex').toString('utf8').trim();
}

async function scanVault(chain, vault) {
  const url = RPCS[chain];
  const taHex = await rpcCall(url, vault.address, '0x01e1d114');  // totalAssets()
  if (!taHex || taHex === '0x') return null;
  const totalAssets = BigInt(taHex);
  if (totalAssets === 0n) return null;

  const assetHex = await rpcCall(url, vault.address, '0x38d52e0f');  // asset()
  const underlying = '0x' + (assetHex || '').slice(-40).toLowerCase();
  const [decHex, symHex] = await Promise.all([
    rpcCall(url, underlying, '0x313ce567'),
    rpcCall(url, underlying, '0x95d89b41'),
  ]);
  const decimals = parseInt(decHex || '0x12', 16);
  const symbol = decodeStr(symHex) || '?';
  const amount = Number(totalAssets) / (10 ** decimals);
  // yoUSD's underlying is USDC — track 1:1.
  return {
    vault_address: vault.address.toLowerCase(),
    vault_name: vault.name,
    chain,
    underlying_address: underlying,
    underlying_symbol: symbol,
    amount,
    value_usd: amount,
  };
}

function savePositions(db, results) {
  // Clean all yo-protocol rows + their dependents first.
  const oldIds = db.prepare(`SELECT id FROM positions WHERE protocol_id = 'yo-protocol'`).all();
  const delTok = db.prepare(`DELETE FROM position_tokens WHERE position_id = ?`);
  const delMkt = db.prepare(`DELETE FROM position_markets WHERE position_id = ?`);
  const delExp = db.prepare(`DELETE FROM exposure_decomposition WHERE position_id = ?`);
  const delPos = db.prepare(`DELETE FROM positions WHERE id = ?`);
  for (const r of oldIds) { delExp.run(r.id); delTok.run(r.id); delMkt.run(r.id); delPos.run(r.id); }

  // protocol_name='yoUSD' is required for the YBS exposure adapter to fire.
  // position_type='Vault' (not 'Lending') so the strategy badge reads "VAULT".
  const upsertPos = db.prepare(`
    INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, net_usd, asset_usd, debt_usd, position_index, scanned_at)
    VALUES (?, ?, 'yo-protocol', 'yoUSD', 'Vault', 'vault', ?, ?, 0, ?, datetime('now'))
    ON CONFLICT(wallet, chain, protocol_id, position_index) DO UPDATE SET
      protocol_name = 'yoUSD', position_type = 'Vault', strategy = 'vault',
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
    if (pos?.id) insertToken.run(pos.id, r.underlying_symbol, r.underlying_address, r.amount, r.value_usd);
  }
}

async function main() {
  console.log('=== YO Protocol Scanner ===\n');
  const results = [];
  for (const [chain, vaults] of Object.entries(VAULTS)) {
    console.log(`[${chain}]`);
    for (const v of vaults) {
      try {
        const r = await scanVault(chain, v);
        if (r && r.value_usd > 0) {
          console.log(`  ${v.name.padEnd(8)} ${r.amount.toFixed(2)} ${r.underlying_symbol} = $${(r.value_usd / 1e6).toFixed(2)}M`);
          results.push(r);
        } else {
          console.log(`  ${v.name.padEnd(8)} (empty)`);
        }
      } catch (e) {
        console.log(`  ${v.name} ERR: ${e.message}`);
      }
    }
  }
  const total = results.reduce((s, r) => s + r.value_usd, 0);
  console.log(`\n=== Total YO TVL: $${(total / 1e6).toFixed(2)}M ===`);

  const db = new Database(DB_PATH);
  savePositions(db, results);
  db.close();
  console.log(`Saved ${results.length} yoUSD vault rows`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { scanVault, savePositions };
