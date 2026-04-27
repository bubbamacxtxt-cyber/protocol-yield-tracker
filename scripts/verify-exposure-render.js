#!/usr/bin/env node
/**
 * Headless verification: load the exposure section render functions against
 * real data.json and print a textual summary of what the UI will show.
 *
 * This catches obvious regressions (empty renders, undefined labels, NaN)
 * without needing a browser.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const js = fs.readFileSync(path.join(ROOT, 'whale-common.js'), 'utf8');

// Lift just the functions we need into a sandboxed context.
const sandbox = {
  fmtUsd: null,
  escapeHtml: null,
  renderExposureDonuts: null,
  renderExposurePositions: null,
  renderPositionExposureCard: null,
  legs_title: null,
  EXPOSURE_PALETTE: null,
  document: { getElementById: () => null },
  window: {},
  requestAnimationFrame: () => {},
};
// Run the script to populate globals. Wrap in a try to ignore references
// to `positions`/`COLUMNS` etc. that aren't needed for rendering.
try {
  vm.createContext(sandbox);
  // Only evaluate the file-level function declarations — skip the bottom
  // half that reads DOM. Easiest: wrap in try/catch globally.
  vm.runInContext(`try { ${js} } catch (e) { /* tolerate DOM refs */ }`, sandbox, { timeout: 5000 });
} catch (err) {
  console.error('sandbox error:', err.message);
}

const missingFns = ['fmtUsd', 'renderExposureDonuts', 'renderPositionExposureCard', 'escapeHtml']
  .filter(n => typeof sandbox[n] !== 'function');
if (missingFns.length) {
  console.error('FAIL: missing functions:', missingFns.join(', '));
  process.exit(1);
}

let issues = 0;
const warn = (msg) => { issues++; console.warn('  ⚠', msg); };

console.log('Verifying exposure UI render for each whale\n');

for (const [name, whale] of Object.entries(data.whales)) {
  const rollup = whale.exposure_rollup;
  const positions = (whale.positions || []).filter(p => (p.exposure_tree || []).length > 0);

  console.log(`— ${name} —`);
  console.log(`  positions: ${whale.positions.length}  with_tree: ${positions.length}  rollup: ${rollup ? 'yes' : 'no'}`);

  if (!rollup) { warn(`${name}: no exposure_rollup`); continue; }

  // Donuts render
  const donutHtml = sandbox.renderExposureDonuts(rollup);
  if (!donutHtml.includes('exp-donut-proto')) warn(`${name}: donut HTML missing proto canvas`);
  if (!donutHtml.includes('exp-donut-token')) warn(`${name}: donut HTML missing token canvas`);
  if (!donutHtml.includes('exp-donut-market')) warn(`${name}: donut HTML missing market canvas`);

  // Check rollup sanity
  const byProtoTotal = (rollup.by_protocol || []).reduce((s, r) => s + r.usd, 0);
  const byTokenTotal = (rollup.by_token || []).reduce((s, r) => s + r.usd, 0);
  const byMarketTotal = (rollup.by_market || []).reduce((s, r) => s + r.usd, 0);
  // These should all equal each other (different groupings of same leaves)
  const diff = Math.abs(byProtoTotal - byTokenTotal);
  if (byProtoTotal > 0 && diff / byProtoTotal > 0.001) {
    warn(`${name}: proto vs token rollup differ: ${diff.toFixed(0)}`);
  }

  // Per-position cards
  const totalWhaleUsd = positions.reduce((s, p) => s + (p.net_usd || 0), 0);
  let emptyCards = 0;
  for (const p of positions) {
    const html = sandbox.renderPositionExposureCard(p, totalWhaleUsd);
    if (!html || html.length < 100) { emptyCards++; continue; }
    if (/undefined|NaN|\[object Object\]/.test(html)) {
      warn(`${name}/${p.protocol_name}: render output has undefined/NaN`);
    }
  }
  if (emptyCards) warn(`${name}: ${emptyCards} positions rendered empty`);

  console.log(`  donut_html_length=${donutHtml.length}  by_proto=${(byProtoTotal/1e6).toFixed(1)}M  by_token=${(byTokenTotal/1e6).toFixed(1)}M  by_market=${(byMarketTotal/1e6).toFixed(1)}M`);
}

console.log('\nChecks complete. Issues: ' + issues);
if (issues > 0) process.exit(1);
