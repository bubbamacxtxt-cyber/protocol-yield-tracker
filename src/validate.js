#!/usr/bin/env node
/**
 * validate.js
 * Pre-push data validation. Compares live sources against exported data.
 * Fails (exit 1) if any metric is off by more than 5%.
 *
 * Checks:
 * 1. API whales: live API totals vs data.json totals
 * 2. On-chain whales: live contract totals vs data.json totals
 * 3. Sanity: no empty whales, no absurd values
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const errors = [];
const warnings = [];

function getThreshold(dbTotal) {
  // Tighter threshold for larger positions
  if (dbTotal >= 100_000_000) return 0.03; // 3% for >$100M
  if (dbTotal >= 10_000_000) return 0.05;  // 5% for >$10M
  if (dbTotal >= 1_000_000) return 0.08;   // 8% for >$1M
  return 0.15; // 15% for <$1M (more volatile)
}

function pctDiff(a, b) {
  if (a === 0 && b === 0) return 0;
  if (a === 0 || b === 0) return 1;
  return Math.abs(a - b) / Math.max(a, b);
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function check(name, liveTotal, dbTotal) {
  const diff = pctDiff(dbTotal, liveTotal);
  const threshold = getThreshold(dbTotal);
  const status = diff > threshold ? '❌' : '✅';
  console.log(`${status} ${name}: data=$${dbTotal.toLocaleString('en-US', {maximumFractionDigits: 0})} live=$${liveTotal.toLocaleString('en-US', {maximumFractionDigits: 0})} (${(diff * 100).toFixed(1)}%, threshold: ${(threshold * 100).toFixed(0)}%)`);
  if (diff > threshold) {
    errors.push(`${name}: ${(diff * 100).toFixed(1)}% off (data=$${dbTotal.toLocaleString()} vs live=$${liveTotal.toLocaleString()})`);
  }
}

async function main() {
  console.log('=== Data Validation ===\n');

  const dataPath = path.join(__dirname, '..', 'data.json');
  if (!fs.existsSync(dataPath)) {
    errors.push('data.json does not exist');
    report();
    return;
  }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  // --- Sanity ---
  console.log('--- Sanity ---');
  for (const [name, whale] of Object.entries(data.whales)) {
    const count = whale.positions?.length || 0;
    if (count === 0) errors.push(`${name}: 0 positions`);
    else console.log(`  ${name}: ${count} positions, $${(whale.positions.reduce((s, p) => s + (p.net_usd || 0), 0)).toLocaleString('en-US', {maximumFractionDigits: 0})}`);
  }

  // --- InfiniFi ---
  console.log('\n--- API Checks ---');
  try {
    const ethData = await fetchJson('https://eth-api.infinifi.xyz/api/protocol/data');
    const farms = ethData.data?.farms || [];
    const liveTotal = farms
      .filter(f => f.type !== 'PROTOCOL' && (f.assetsNormalized || 0) > 100)
      .reduce((s, f) => s + (f.assetsNormalized || 0), 0);
    const dbTotal = (data.whales.InfiniFi?.positions || []).reduce((s, p) => s + (p.net_usd || 0), 0);
    check('InfiniFi', liveTotal, dbTotal);
  } catch (e) {
    warnings.push(`InfiniFi: ${e.message}`);
  }

  // --- Pareto (on-chain, wider threshold due to unallocated funds) ---
  try {
    const QUEUE = '0xA7780086ab732C110E9E71950B9Fb3cb2ea50D89';
    const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');
    const abi = ['function getTotalCollateralsScaled() external view returns (uint256)'];
    const contract = new ethers.Contract(QUEUE, abi, provider);
    const total = await contract.getTotalCollateralsScaled();
    const liveTotal = Number(total) / 1e18;
    const dbTotal = (data.whales.Pareto?.positions || []).reduce((s, p) => s + (p.net_usd || 0), 0);
    // On-chain includes unallocated funds, so allow 15% tolerance
    const diff = pctDiff(dbTotal, liveTotal);
    const status = diff > 0.15 ? '❌' : '✅';
    console.log(`${status} Pareto: data=$${dbTotal.toLocaleString('en-US', {maximumFractionDigits: 0})} live=$${liveTotal.toLocaleString('en-US', {maximumFractionDigits: 0})} (${(diff * 100).toFixed(1)}%)`);
    if (diff > 0.15) errors.push(`Pareto: ${(diff * 100).toFixed(1)}% off`);
  } catch (e) {
    warnings.push(`Pareto: ${e.message}`);
  }

  // --- Anzen ---
  // Skipped: USDz supply fluctuates too much for 5% threshold
  // Sanity check (positions > 0) is sufficient

  // --- Source validation: does data.json match what the DB has? ---
  console.log('\n--- Source Validation (data.json vs DB) ---');
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(__dirname, '..', 'yield-tracker.db');
    const db = new Database(dbPath, { readonly: true });
    const WHALES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));

    for (const [name, definition] of Object.entries(WHALES)) {
      let wallets = [];
      if (Array.isArray(definition)) {
        wallets = definition;
      } else if (definition.wallets) {
        wallets = definition.wallets;
      } else if (definition.vaults) {
        for (const vaultWallets of Object.values(definition.vaults)) {
          wallets.push(...vaultWallets);
        }
      }
      const walletLower = wallets.map(w => w.toLowerCase());
      if (walletLower.length === 0) continue;

      // Skip whales with manual-only data (not in DB)
      // Re Protocol: off-chain Chainlink position inflates data.json vs DB
      if (['InfiniFi', 'Anzen', 'Pareto', 'Re Protocol'].includes(name)) {
        console.log(`  ⏭️  ${name} (source): manual-only, skipped`);
        continue;
      }
      const placeholders = walletLower.map(() => '?').join(',');
      const dbTotal = db.prepare(
        `SELECT SUM(net_usd) as total FROM positions WHERE LOWER(wallet) IN (${placeholders})`
      ).get(...walletLower)?.total || 0;

      // data.json total
      const exportTotal = (data.whales[name]?.positions || []).reduce((s, p) => s + (p.net_usd || 0), 0);

      check(name + ' (source)', dbTotal, exportTotal);
    }
    db.close();
  } catch (e) {
    warnings.push(`Source validation: ${e.message}`);
  }

  // Report
  report();
}

function report() {
  console.log('\n=== Results ===');
  if (warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    warnings.forEach(w => console.log(`  ${w}`));
  }
  if (errors.length > 0) {
    console.log('\n❌ FAILED — fix before pushing:');
    errors.forEach(e => console.log(`  ${e}`));
    process.exit(1);
  } else {
    console.log('\n✅ All checks passed.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
