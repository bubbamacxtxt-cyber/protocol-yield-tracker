#!/usr/bin/env node
/**
 * fetch-pareto.js
 * Fetches Pareto Credit USP vault positions from their public API.
 *
 * API: https://app.pareto.credit/api/v1/
 *
 * Outputs: data/whales/pareto.json + data/manual-positions.json (Pareto section)
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://app.pareto.credit/api/v1';
const USP_VAULT_ID = '68026ee6905992e056c85a75';
const USP_ADDRESS = '0x97cCC1C046d067ab945d3CF3CC6920D3b1E54c88';

const CREDIT_VAULT_IDS = [
  '6703f887115a372bcf5936ea',  // Fasanara Digital
  '6825b4363ac7644d17e2bffd',  // Bastion Trading
  '684149d45a56723ad4eff591',  // Adaptive Frontier
  '687e1219e1d966cdc7a5d64a',  // RockawayX
];

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function parseTokenAmount(wei, decimals = 6) {
  return Number(wei) / Math.pow(10, decimals);
}

function mapVaultToPosition(vault, latestBlock) {
  const apys = latestBlock?.APYs || {};
  const tvl = latestBlock?.TVL || {};
  const tvlUsd = Number(tvl.USD || 0) / 1e6; // 6 decimals (USDC)
  const supply = Number(latestBlock?.totalSupply || '0') / 1e18;

  return {
    wallet: 'off-chain',
    chain: 'eth',
    protocol_name: vault.name,
    protocol_id: vault._id,
    position_type: 'Illiquid',
    strategy: 'rwa',
    yield_source: vault.name.toLowerCase().split(' ')[0],
    health_rate: null,
    net_usd: tvlUsd,
    asset_usd: tvlUsd,
    debt_usd: 0,
    supply: [{
      symbol: vault.symbol || 'USDC',
      real_symbol: vault.symbol || 'USDC',
      amount: tvlUsd,
      price_usd: 1,
      value_usd: tvlUsd,
    }],
    borrow: [],
    rewards: [],
    apy_current: parseFloat(((apys.NET || 0)).toFixed(2)),
    apy_gross: parseFloat(((apys.GROSS || 0)).toFixed(2)),
    apy_avg: parseFloat(((apys.NET || 0)).toFixed(2)),
    apy_base: parseFloat(((apys.BASE || 0)).toFixed(2)),
    apy_rewards: 0.00,
    apy_fee: apys.FEE || 0,
    maturity: null,
    bucket_weeks: null,
    underlying: 'USDC',
    paused: false,
    manual: true,
    asset_type: vault.contractType || 'Credit Vault',
    vault_description: vault.shortDescription?.en || '',
  };
}

async function main() {
  console.log('Pareto Credit Fetcher');
  console.log('=====================\n');

  // 1. Get USP vault data
  console.log('Fetching USP vault...');
  const uspVault = await fetchJson(`${API_BASE}/vaults?address=${USP_ADDRESS}`);
  const uspData = uspVault.data?.[0];
  if (!uspData) throw new Error('USP vault not found');
  console.log(`  ${uspData.name} (${uspData.symbol})\n`);

  // 2. Get credit vaults
  console.log('Fetching credit vaults...');
  const vaultsUrl = `${API_BASE}/vaults?_id=${CREDIT_VAULT_IDS.join(',')}`;
  const vaultsRes = await fetchJson(vaultsUrl);
  const vaults = vaultsRes.data || [];

  const positions = [];

  // 4. For each credit vault, get latest block data
  for (const vault of vaults) {
    console.log(`  ${vault.name}...`);
    const blocksUrl = `${API_BASE}/vault-blocks?vaultAddress=${vault.address}&sort=block&order=desc&limit=1`;
    const blocksRes = await fetchJson(blocksUrl);
    const block = blocksRes.data?.[0];

    if (block) {
      const pos = mapVaultToPosition(vault, block);
      // Only include if it has actual TVL
      if (pos.net_usd > 0) {
        positions.push(pos);
        console.log(`    ${pos.protocol_name}: $${pos.net_usd.toLocaleString('en-US', { maximumFractionDigits: 0 })} @ ${pos.apy_current}% net`);
      } else {
        console.log(`    ${vault.name}: 0 TVL, skipping`);
      }
    }
  }

  // 5. Sort by TVL descending
  positions.sort((a, b) => b.net_usd - a.net_usd);

  const totalUsd = positions.reduce((sum, p) => sum + p.net_usd, 0);
  console.log(`\nTotal: ${positions.length} positions, $${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  // 6. Write to separate file
  const whalesDir = path.join(__dirname, '..', 'data', 'whales');
  if (!fs.existsSync(whalesDir)) fs.mkdirSync(whalesDir, { recursive: true });
  const outFile = path.join(whalesDir, 'pareto.json');
  fs.writeFileSync(outFile, JSON.stringify({ Pareto: positions }, null, 2));
  console.log(`\nWrote ${outFile}`);

  // 7. Update manual-positions.json
  const manualPath = path.join(__dirname, '..', 'data', 'manual-positions.json');
  let existing = {};
  if (fs.existsSync(manualPath)) {
    existing = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  }
  existing.Pareto = positions;
  fs.writeFileSync(manualPath, JSON.stringify(existing, null, 2));

  // 8. Run export
  console.log('\nRunning export...');
  try {
    require('child_process').execSync('node src/export.js', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('Export failed:', err.message);
  }

  // 9. Print summary
  console.log('\n--- Pareto Positions ---');
  console.log('Vault'.padEnd(30) + 'TVL'.padStart(16) + ' Gross APY'.padStart(12) + ' Net APY'.padStart(10) + ' Fee');
  console.log('-'.repeat(80));
  for (const p of positions) {
    console.log(
      p.protocol_name.padEnd(30) +
      `$${p.net_usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`.padStart(16) +
      `${p.apy_gross}%`.padStart(12) +
      `${p.apy_current}%`.padStart(10) +
      ` ${p.apy_fee}%`
    );
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
