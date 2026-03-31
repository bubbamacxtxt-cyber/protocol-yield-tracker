#!/usr/bin/env node
/**
 * fetch-pareto.js
 * Fetches Pareto Credit sUSP vault data.
 *
 * sUSP = staked USP, earns yield from RWA private credit strategies.
 * The allocation to individual credit vaults is computed on-chain by the frontend.
 * We use the vault-blocks API for APY data and hardcode the allocation from the frontend.
 *
 * API: https://app.pareto.credit/api/v1/
 *
 * Outputs: data/whales/pareto.json + data/manual-positions.json (Pareto section)
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://app.pareto.credit/api/v1';
const USP_ADDRESS = '0x97cCC1C046d067ab945d3CF3CC6920D3b1E54c88';

// Credit vault addresses (used to fetch APY)
const CREDIT_VAULTS = [
  { name: 'Fasanara Digital', address: '0x45054c6753b4Bce40C5d54418DabC20b070F85bE', strategy: 'Basis Trading' },
  { name: 'Bastion Trading', address: '0xC49b4ECc14aa31Ef0AD077EdcF53faB4201b724c', strategy: 'Derivatives Desk' },
  { name: 'Sky', address: null, strategy: 'DeFi' },
  { name: 'Adaptive Frontier', address: '0xae7913c672c7F1f76C2a1a0Ac4de97d082681234', strategy: 'HF Trading' },
  { name: 'RockawayX', address: '0xEC6a70F62a83418c7fb238182eD2865F80491a8B', strategy: 'Private Credit & DeFi' },
];

// Allocation from frontend (as of 2026-03-31)
// These are the sUSP deposits into each credit vault
// Source: app.pareto.credit/usp frontend
const ALLOCATION = [
  { name: 'Fasanara Digital', usd: 899581.99, apy: 25.25 },
  { name: 'Bastion Trading', usd: 0, apy: 0 },
  { name: 'Sky', usd: 136089.15, apy: 3.82 },
  { name: 'Adaptive Frontier', usd: 1521212.96, apy: 42.7 },
  { name: 'RockawayX', usd: 1005629.99, apy: 28.23 },
];

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function enrichWithApiData(positions) {
  // Try to get latest APY from API for vaults that have on-chain addresses
  for (const vault of CREDIT_VAULTS) {
    if (!vault.address) continue;
    try {
      const blocksUrl = `${API_BASE}/vault-blocks?vaultAddress=${vault.address}&sort=block&order=desc&limit=1`;
      const res = await fetchJson(blocksUrl);
      const block = res.data?.[0];
      if (block?.APYs) {
        const pos = positions.find(p => p.protocol_name === vault.name);
        if (pos) {
          // Update gross APY from API if available
          pos.apy_gross = parseFloat((block.APYs.GROSS || 0).toFixed(2));
          pos.apy_fee = block.APYs.FEE || 0;
        }
      }
    } catch (e) {
      // Silent fail, use frontend APY
    }
  }
}

function buildPosition(alloc) {
  const vault = CREDIT_VAULTS.find(v => v.name === alloc.name);
  return {
    wallet: 'off-chain',
    chain: 'eth',
    protocol_name: alloc.name,
    protocol_id: alloc.name.toLowerCase().replace(/\s+/g, '-'),
    position_type: 'Illiquid',
    strategy: 'rwa',
    yield_source: alloc.name.toLowerCase().split(' ')[0],
    health_rate: null,
    net_usd: alloc.usd,
    asset_usd: alloc.usd,
    debt_usd: 0,
    supply: [{
      symbol: 'USDC',
      real_symbol: 'USDC',
      amount: alloc.usd,
      price_usd: 1,
      value_usd: alloc.usd,
    }],
    borrow: [],
    rewards: [],
    apy_current: parseFloat(alloc.apy.toFixed(2)),
    apy_avg: parseFloat(alloc.apy.toFixed(2)),
    apy_base: parseFloat(alloc.apy.toFixed(2)),
    apy_rewards: 0.00,
    maturity: null,
    bucket_weeks: null,
    underlying: 'USDC',
    paused: false,
    manual: true,
    asset_type: vault?.strategy || 'Credit Vault',
  };
}

async function main() {
  console.log('Pareto Credit Fetcher (sUSP)');
  console.log('============================\n');

  // 1. Build positions from allocation data
  let positions = ALLOCATION.filter(a => a.usd > 0).map(buildPosition);

  // 2. Try to enrich with API APY data
  await enrichWithApiData(positions);

  // 3. Sort by TVL descending
  positions.sort((a, b) => b.net_usd - a.net_usd);

  const totalUsd = positions.reduce((sum, p) => sum + p.net_usd, 0);
  console.log(`sUSP total: $${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`);

  for (const p of positions) {
    console.log(`  ${p.protocol_name.padEnd(25)} $${p.net_usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).padStart(12)}  ${p.apy_current}%  ${p.asset_type}`);
  }

  // 4. Write to separate file
  const whalesDir = path.join(__dirname, '..', 'data', 'whales');
  if (!fs.existsSync(whalesDir)) fs.mkdirSync(whalesDir, { recursive: true });
  const outFile = path.join(whalesDir, 'pareto.json');
  fs.writeFileSync(outFile, JSON.stringify({ Pareto: positions }, null, 2));
  console.log(`\nWrote ${outFile}`);

  // 5. Update manual-positions.json
  const manualPath = path.join(__dirname, '..', 'data', 'manual-positions.json');
  let existing = {};
  if (fs.existsSync(manualPath)) {
    existing = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  }
  existing.Pareto = positions;
  fs.writeFileSync(manualPath, JSON.stringify(existing, null, 2));

  // 6. Run export
  console.log('\nRunning export...');
  try {
    require('child_process').execSync('node src/export.js', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('Export failed:', err.message);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
