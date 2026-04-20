#!/usr/bin/env node
/**
 * fetch-pareto.js
 * Fetches Pareto Credit sUSP vault data from on-chain + API.
 *
 * On-chain: ParetoDollarQueue at 0xA7780086ab732C110E9E71950B9Fb3cb2ea50D89
 * API: https://app.pareto.credit/api/v1/ (for APY data)
 *
 * Outputs: data/whales/pareto.json + data/manual-positions.json (Pareto section)
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const API_BASE = 'https://app.pareto.credit/api/v1';
const QUEUE_ADDRESS = '0xA7780086ab732C110E9E71950B9Fb3cb2ea50D89';
const RPC = 'https://ethereum-rpc.publicnode.com';

// Map source addresses to human names (from on-chain + API cross-reference)
const SOURCE_NAMES = {
  '0xf6223c567f21e33e859ed7a045773526e9e3c2d5': { name: 'Fasanara Digital', strategy: 'Basis Trading' },
  '0x4462ed748b8f7985a4ac6b538dfc105fce2dd165': { name: 'Bastion Trading', strategy: 'Derivatives Desk' },
  '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd': { name: 'Sky', strategy: 'DeFi' },
  '0xa188eec8f81263234da3622a406892f3d630f98c': { name: 'Unlent', strategy: 'Cash' },
  '0x14b8e918848349d1e71e806a52c13d4e0d3246e0': { name: 'Adaptive Frontier', strategy: 'HF Trading' },
  '0x9cf358aff79dea96070a85f00c0ac79569970ec3': { name: 'RockawayX', strategy: 'Private Credit & DeFi' },
};

// Vault addresses for API APY lookup
const VAULT_APY_MAP = {
  'Fasanara Digital': '0x45054c6753b4Bce40C5d54418DabC20b070F85bE',
  'Bastion Trading': '0xC49b4ECc14aa31Ef0AD077EdcF53faB4201b724c',
  'Adaptive Frontier': '0xae7913c672c7F1f76C2a1a0Ac4de97d082681234',
  'RockawayX': '0xEC6a70F62a83418c7fb238182eD2865F80491a8B',
};

const QUEUE_ABI = [
  'function getAllYieldSources() external view returns (tuple(address token, address source, address vaultToken, uint256 maxCap, tuple(bytes4 method, uint8 methodType)[] allowedMethods, uint8 vaultType)[])',
  'function getCollateralsYieldSourceScaled(address) external view returns (uint256)',
  'function getTotalCollateralsScaled() external view returns (uint256)',
  'function getUnlentBalanceScaled() external view returns (uint256)',
];

async function getOnChainAllocation() {
  console.log('Fetching on-chain allocation...');
  const provider = new ethers.JsonRpcProvider(RPC);
  const queue = new ethers.Contract(QUEUE_ADDRESS, QUEUE_ABI, provider);

  const total = await queue.getTotalCollateralsScaled();
  const totalUsd = Number(total) / 1e18;
  console.log(`  Total collaterals: $${totalUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

  const sources = await queue.getAllYieldSources();
  const allocations = [];

  for (const s of sources) {
    const coll = await queue.getCollateralsYieldSourceScaled(s.source);
    const collUsd = Number(coll) / 1e18;
    const sourceLower = s.source.toLowerCase();
    const info = SOURCE_NAMES[sourceLower] || { name: s.source, strategy: 'Unknown' };

    if (collUsd > 0) {
      allocations.push({
        source: s.source,
        name: info.name,
        strategy: info.strategy,
        usd: collUsd,
        vaultType: Number(s.vaultType),
      });
    }
    console.log(`  ${info.name}: $${collUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  }

  return { totalUsd, allocations };
}

async function enrichWithApy(allocations) {
  console.log('\nFetching APY from API...');
  for (const alloc of allocations) {
    const vaultAddr = VAULT_APY_MAP[alloc.name];
    if (!vaultAddr) continue;

    try {
      const res = await fetch(`${API_BASE}/vault-blocks?vaultAddress=${vaultAddr}&sort=block&order=desc&limit=1`);
      const json = await res.json();
      const block = json.data?.[0];
      if (block?.APYs) {
        alloc.apy_gross = parseFloat((block.APYs.GROSS || 0).toFixed(2));
        alloc.apy_net = parseFloat((block.APYs.NET || 0).toFixed(2));
        alloc.apy_fee = block.APYs.FEE || 0;
        console.log(`  ${alloc.name}: ${alloc.apy_gross}% gross / ${alloc.apy_net}% net`);
      }
    } catch (e) {
      console.log(`  ${alloc.name}: APY lookup failed`);
    }
  }
}

function buildPosition(alloc) {
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
    apy_current: alloc.apy_net || 0,
    apy_gross: alloc.apy_gross || 0,
    apy_avg: alloc.apy_net || 0,
    apy_base: alloc.apy_net || 0,
    apy_rewards: 0.00,
    apy_fee: alloc.apy_fee || 0,
    maturity: null,
    bucket_weeks: null,
    underlying: 'USDC',
    paused: false,
    manual: false,
    source_type: 'protocol_api',
    source_name: 'fetch-pareto',
    discovery_type: 'mixed',
    asset_type: alloc.strategy,
  };
}

async function main() {
  console.log('Pareto Credit Fetcher (sUSP)');
  console.log('============================\n');

  // 1. Get allocation from on-chain
  const { totalUsd, allocations } = await getOnChainAllocation();

  // 2. Enrich with APY from API
  await enrichWithApy(allocations);

  // 3. Build positions (filter out zero and unlent)
  const positions = allocations
    .filter(a => a.usd > 0 && a.name !== 'Unlent')
    .map(buildPosition)
    .sort((a, b) => b.net_usd - a.net_usd);

  console.log(`\nsUSP: $${totalUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })} across ${positions.length} positions\n`);

  // 4. Write to files
  const whalesDir = path.join(__dirname, '..', 'data', 'whales');
  if (!fs.existsSync(whalesDir)) fs.mkdirSync(whalesDir, { recursive: true });
  fs.writeFileSync(path.join(whalesDir, 'pareto.json'), JSON.stringify({ Pareto: positions }, null, 2));

  const manualPath = path.join(__dirname, '..', 'data', 'manual-positions.json');
  let existing = {};
  if (fs.existsSync(manualPath)) {
    existing = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  }
  existing.Pareto = positions;
  fs.writeFileSync(manualPath, JSON.stringify(existing, null, 2));

  // 5. Run export
  console.log('Running export...');
  try {
    require('child_process').execSync('node src/export.js', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('Export failed:', err.message);
  }

  // 6. Print summary
  console.log('\n--- Pareto Positions (sUSP) ---');
  console.log('Vault'.padEnd(25) + 'TVL'.padStart(14) + ' Gross'.padStart(10) + ' Net'.padStart(10) + ' Type');
  console.log('-'.repeat(70));
  for (const p of positions) {
    console.log(
      p.protocol_name.padEnd(25) +
      `$${p.net_usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`.padStart(14) +
      `${p.apy_gross}%`.padStart(10) +
      `${p.apy_current}%`.padStart(10) +
      ` ${p.asset_type}`
    );
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
