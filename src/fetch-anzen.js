#!/usr/bin/env node
/**
 * fetch-anzen.js
 * Fetches Anzen RWA collateral positions from their API + on-chain USDz supply.
 *
 * API: https://rwa-api.anzen.finance/collaterals?page=1
 * MMZ (Institutional Blended Note) is a calculated residual:
 *   MMZ = USDz_total_supply - sum(API commitments)
 *
 * Outputs: data/manual-positions.json (Anzen section)
 */

const fs = require('fs');
const path = require('path');

const API_URL = 'https://rwa-api.anzen.finance/collaterals?page=1';

// RPC endpoints for USDz totalSupply calls
const USDZ_CONTRACTS = [
  { chain: 'eth', chainId: 1, rpc: 'https://eth.llamarpc.com', address: '0xA469B7Ee9ee773642b3e93E842e5D9b5BaA10067' },
  { chain: 'base', chainId: 8453, rpc: 'https://mainnet.base.org', address: '0x04D5ddf5f3a8939889F11E97f8c4BB48317F1938' },
  { chain: 'blast', chainId: 81457, rpc: 'https://rpc.blast.io', address: '0x52056ED29Fe015f4Ba2e3b079D10C0B87f46e8c6' },
];

// ERC20 totalSupply() selector: 0x18160ddd
const TOTAL_SUPPLY_ABI = '0x18160ddd';

async function getTotalSupply(chainName, rpc, address) {
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: address, data: TOTAL_SUPPLY_ABI }, 'latest'],
      }),
    });
    const json = await res.json();
    if (json.error) {
      console.error(`  ${chainName}: RPC error: ${json.error.message}`);
      return 0n;
    }
    return BigInt(json.result);
  } catch (err) {
    console.error(`  ${chainName}: ${err.message}`);
    return 0n;
  }
}

async function getUsdzSupply() {
  console.log('Fetching USDz supply from on-chain...');
  let total = 0n;
  for (const c of USDZ_CONTRACTS) {
    const supply = await getTotalSupply(c.chain, c.rpc, c.address);
    const normalized = Number(supply) / 1e18;
    console.log(`  ${c.chain}: ${normalized.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDz`);
    total += supply;
  }
  const totalNormalized = Number(total) / 1e18;
  console.log(`  Total: ${totalNormalized.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDz\n`);
  return totalNormalized;
}

function formatMaturity(dateStr) {
  if (!dateStr) return null;
  return dateStr; // Already YYYY-MM-DD
}

function mapApiCollateral(c) {
  const a = c.attributes;
  const principal = parseFloat(a.commitment || a.principal || 0);
  const apyBps = a.apy || 0;
  const apyPct = apyBps / 100; // basis points -> %

  return {
    wallet: 'off-chain',
    chain: 'eth',
    protocol_name: a.ticker,
    protocol_id: a.ticker.toLowerCase(),
    position_type: 'Illiquid',
    strategy: 'rwa',
    yield_source: a.asset_type?.toLowerCase().split(' ')[0] || 'rwa',
    health_rate: null,
    net_usd: principal,
    asset_usd: principal,
    debt_usd: 0,
    supply: [{
      symbol: 'USDz',
      real_symbol: 'USDz',
      amount: principal,
      price_usd: 1,
      value_usd: principal,
    }],
    borrow: [],
    rewards: [],
    apy_current: parseFloat(apyPct.toFixed(2)),
    apy_avg: parseFloat(apyPct.toFixed(2)),
    apy_base: parseFloat(apyPct.toFixed(2)),
    apy_rewards: 0.00,
    maturity: formatMaturity(a.maturity_date),
    bucket_weeks: null,
    underlying: 'USDz',
    paused: false,
    manual: true,
    // Extra metadata for display
    asset_type: a.asset_type || 'RWA',
    financing_type: a.financing_type || '',
    deal_type: a.deal_type || '',
    preference: a.preference || '',
  };
}

function buildMmzPosition(usdzSupply, apiCommitments) {
  const mmzPrincipal = Math.max(0, usdzSupply - apiCommitments);

  // Maturity is 3 months from now (matches frontend logic)
  const maturity = new Date();
  maturity.setMonth(maturity.getMonth() + 3);
  const maturityStr = maturity.toISOString().split('T')[0];

  return {
    wallet: 'off-chain',
    chain: 'eth',
    protocol_name: 'MMZ20240501ZZZ500',
    protocol_id: 'mmz-blended-note',
    position_type: 'Illiquid',
    strategy: 'rwa',
    yield_source: 'institutional',
    health_rate: null,
    net_usd: mmzPrincipal,
    asset_usd: mmzPrincipal,
    debt_usd: 0,
    supply: [{
      symbol: 'USDz',
      real_symbol: 'USDz',
      amount: mmzPrincipal,
      price_usd: 1,
      value_usd: mmzPrincipal,
    }],
    borrow: [],
    rewards: [],
    apy_current: 5.00, // Hardcoded 500 bps in frontend
    apy_avg: 5.00,
    apy_base: 5.00,
    apy_rewards: 0.00,
    maturity: maturityStr,
    bucket_weeks: null,
    underlying: 'USDz',
    paused: false,
    manual: true,
    asset_type: 'Institutional Blended Note',
    financing_type: 'Asset Backed',
    deal_type: 'Institutional Blended Note',
    preference: 'Senior',
  };
}

async function main() {
  console.log('Anzen RWA Fetcher');
  console.log('=================\n');

  // 1. Fetch API collaterals
  console.log('Fetching API collaterals...');
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const apiData = await res.json();
  const allCollaterals = apiData.data || [];
  console.log(`  ${allCollaterals.length} total collaterals from API\n`);

  // 2. Filter to active positions (principal > 0, maturity in future)
  const today = new Date().toISOString().split('T')[0];
  const activeCollaterals = allCollaterals.filter(c => {
    const principal = parseFloat(c.attributes.commitment || c.attributes.principal || 0);
    const maturity = c.attributes.maturity_date;
    return principal > 0 && maturity && maturity >= today;
  });
  console.log(`Active positions (principal > 0, maturity >= ${today}):`);
  let apiCommitments = 0;
  for (const c of activeCollaterals) {
    const a = c.attributes;
    const commitment = parseFloat(a.commitment || a.principal);
    apiCommitments += commitment;
    console.log(`  ${a.ticker}: $${commitment.toLocaleString('en-US', { maximumFractionDigits: 0 })} @ ${(a.apy / 100).toFixed(2)}% — ${a.asset_type} — mat: ${a.maturity_date}`);
  }
  console.log(`  API commitments total: $${apiCommitments.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n`);

  // 3. Get USDz supply
  const usdzSupply = await getUsdzSupply();

  // 4. Calculate MMZ residual
  const mmzPosition = buildMmzPosition(usdzSupply, apiCommitments);
  console.log(`MMZ (Institutional Blended Note):`);
  console.log(`  USDz supply: $${usdzSupply.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  console.log(`  API commitments: $${apiCommitments.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  console.log(`  MMZ residual: $${mmzPosition.net_usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n`);

  // 5. Build all positions
  const positions = [...activeCollaterals.map(mapApiCollateral), mmzPosition];
  positions.sort((a, b) => b.net_usd - a.net_usd);

  const totalUsd = positions.reduce((sum, p) => sum + p.net_usd, 0);
  console.log(`Total: ${positions.length} positions, $${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`);

  // 6. Write to separate file (don't clobber other whales)
  const whalesDir = path.join(__dirname, '..', 'data', 'whales');
  if (!fs.existsSync(whalesDir)) fs.mkdirSync(whalesDir, { recursive: true });
  const outFile = path.join(whalesDir, 'anzen.json');
  fs.writeFileSync(outFile, JSON.stringify({ Anzen: positions }, null, 2));
  console.log(`Wrote ${outFile}`);
  console.log(`  Anzen: ${positions.length} positions`);

  // Also update manual-positions.json (merge all whales)
  const manualPath = path.join(__dirname, '..', 'data', 'manual-positions.json');
  let existing = {};
  if (fs.existsSync(manualPath)) {
    existing = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  }
  existing.Anzen = positions;
  fs.writeFileSync(manualPath, JSON.stringify(existing, null, 2));
  console.log(`Wrote ${manualPath}`);
  console.log(`  Anzen: ${positions.length} positions`);

  // 7. Run export
  console.log('\nRunning export...');
  try {
    require('child_process').execSync('node src/export.js', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('Export failed:', err.message);
  }

  // 8. Print summary
  console.log('\n--- Anzen Positions ---');
  console.log('Ticker'.padEnd(35) + 'Type'.padEnd(30) + 'Assets'.padStart(16) + ' APY'.padStart(8) + ' Maturity');
  console.log('-'.repeat(100));
  for (const p of positions) {
    console.log(
      p.protocol_name.padEnd(35) +
      (p.asset_type || '').padEnd(30) +
      `$${p.net_usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`.padStart(16) +
      `${p.apy_current}%`.padStart(8) +
      ` ${p.maturity || '-'}`
    );
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
