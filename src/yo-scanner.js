#!/usr/bin/env node
/**
 * YO Protocol Scanner — IDLE BALANCE ONLY
 *
 * yoUSD is an ERC-4626 vault that holds USDC and deploys it into Morpho
 * markets. The Morpho positions are held BY THE VAULT'S OWN ADDRESS
 * (`0x0000000f2eB9...`), so the morpho-scanner already finds them via
 * Morpho's GraphQL `userByAddress` query — labeled correctly as Morpho
 * positions with the right market info.
 *
 * This scanner only fills the gap between totalAssets() and what
 * morpho-scanner captured: the IDLE USDC sitting in the vault that
 * hasn't been deployed to a strategy yet.
 *
 * If yoUSD ever deploys to non-Morpho protocols (Aave, Euler, etc.),
 * those scanners would also catch it the same way — so this scanner
 * stays focused on residual idle.
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
  eth: { address: '0x0000000f2eB9f69274678c76222B35eEc7588a65', name: 'yoUSD' },
  base: { address: '0x0000000f2eB9f69274678c76222B35eEc7588a65', name: 'yoUSD' },
};

const CHAIN_IDS = { eth: 1, base: 8453 };

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

async function getTotalAssetsUsd(chain, vault) {
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
  // yoUSD's underlying is USDC — use $1 (it tracks USDC closely; small drift is noise).
  const valueUsd = amount;  // 1:1 with USDC
  return { underlying, symbol, amount, value_usd: valueUsd };
}

async function getMorphoPositionsUsd(wallet, chainId) {
  try {
    const res = await fetch('https://app.morpho.org/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ userByAddress(address:"${wallet}", chainId:${chainId}) { marketPositions { supplyAssetsUsd } } }`,
      }),
    });
    const d = await res.json();
    const positions = d.data?.userByAddress?.marketPositions || [];
    return positions.reduce((s, p) => s + Number(p.supplyAssetsUsd || 0), 0);
  } catch {
    return 0;
  }
}

function savePositions(db, results) {
  // Clean all yo-protocol rows first (including any strategy-row residue
  // from the deprecated per-strategy-emission approach).
  const oldIds = db.prepare(`SELECT id FROM positions WHERE protocol_id = 'yo-protocol'`).all();
  const delTok = db.prepare(`DELETE FROM position_tokens WHERE position_id = ?`);
  const delMkt = db.prepare(`DELETE FROM position_markets WHERE position_id = ?`);
  const delExp = db.prepare(`DELETE FROM exposure_decomposition WHERE position_id = ?`);
  const delPos = db.prepare(`DELETE FROM positions WHERE id = ?`);
  for (const r of oldIds) { delExp.run(r.id); delTok.run(r.id); delMkt.run(r.id); delPos.run(r.id); }

  const upsertPos = db.prepare(`
    INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, net_usd, asset_usd, debt_usd, position_index, scanned_at)
    VALUES (?, ?, 'yo-protocol', 'yoUSD Idle', 'Vault', 'vault', ?, ?, 0, ?, datetime('now'))
  `);
  const findPos = db.prepare(`SELECT id FROM positions WHERE lower(wallet) = ? AND chain = ? AND protocol_id = 'yo-protocol' AND position_index = ?`);
  const insertToken = db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, value_usd, apy_base, bonus_supply_apy)
    VALUES (?, 'supply', ?, ?, ?, ?, NULL, NULL)
  `);
  // Write a depth=0 exposure row so the secondary-risk donut on the whale
  // page sees the idle USDC as USDC (not "?"). build-exposure won't
  // generate one since yo-protocol isn't in any adapter's protocol_names.
  const insertExp = db.prepare(`
    INSERT INTO exposure_decomposition (position_id, depth, kind, venue, asset_symbol, asset_address, chain, usd, pct_of_parent, pct_of_root, adapter, source, confidence, as_of)
    VALUES (?, 0, 'pool_share', 'yoUSD Idle', ?, ?, ?, ?, 100, 100, 'yo', 'protocol-api', 'high', datetime('now'))
  `);

  for (const r of results) {
    if (!r.idle_usd || r.idle_usd < 1000) continue;  // skip dust
    const wallet = r.vault_address.toLowerCase();
    const idx = `${r.chain}|yoUSD|idle`;
    upsertPos.run(wallet, r.chain, r.idle_usd, r.idle_usd, idx);
    const pos = findPos.get(wallet, r.chain, idx);
    if (pos?.id) {
      insertToken.run(pos.id, r.symbol, r.underlying, r.idle_amount, r.idle_usd);
      insertExp.run(pos.id, r.symbol, r.underlying, r.chain, r.idle_usd);
    }
  }
}

async function main() {
  console.log('=== YO Protocol Scanner (idle-only mode) ===\n');
  const results = [];

  for (const [chain, vault] of Object.entries(VAULTS)) {
    console.log(`[${chain}]`);
    try {
      const ta = await getTotalAssetsUsd(chain, vault);
      if (!ta || ta.value_usd <= 0) { console.log('  (empty)'); continue; }
      const morphoUsd = await getMorphoPositionsUsd(vault.address, CHAIN_IDS[chain]);
      const idleUsd = Math.max(0, ta.value_usd - morphoUsd);
      const idleAmount = ta.amount * (idleUsd / ta.value_usd);
      console.log(`  totalAssets:    $${(ta.value_usd / 1e6).toFixed(2)}M (${ta.amount.toFixed(2)} ${ta.symbol})`);
      console.log(`  morpho-scanner: $${(morphoUsd / 1e6).toFixed(2)}M (already captured natively)`);
      console.log(`  idle yoUSD:     $${(idleUsd / 1e6).toFixed(2)}M`);
      results.push({
        vault_address: vault.address,
        vault_name: vault.name,
        chain,
        underlying: ta.underlying,
        symbol: ta.symbol,
        idle_amount: idleAmount,
        idle_usd: idleUsd,
      });
    } catch (e) {
      console.log(`  ERR: ${e.message}`);
    }
  }

  const db = new Database(DB_PATH);
  savePositions(db, results);
  db.close();
  const written = results.filter(r => r.idle_usd >= 1000).length;
  console.log(`\nSaved ${written} idle position rows`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { getTotalAssetsUsd, getMorphoPositionsUsd, savePositions };
