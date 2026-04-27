/**
 * Smoke tests for the exposure orchestrator.
 *
 * Run with:  node test/exposure/smoke.test.js
 *
 * Verifies:
 *  - adapters load
 *  - registry resolves known protocols
 *  - _base validates rows
 *  - unknown adapter always returns something
 *
 * These are pure-JS tests (no external API calls). CI smoke step.
 */

const assert = require('assert');
const { loadAllAdapters, resolveAdapter } = require('../../src/exposure/registry');
const { validateRow, unknownRow, primaryAssetRow, opaqueRow } = require('../../src/exposure/adapters/_base');

function test(name, fn) {
  try {
    fn();
    console.log('  \u2713 ' + name);
  } catch (err) {
    console.error('  \u2717 ' + name + '\n    ' + err.message);
    process.exitCode = 1;
  }
}

console.log('exposure smoke tests');

test('adapters load without error', () => {
  const adapters = loadAllAdapters();
  assert.ok(adapters.length > 5, `expected >5 adapters, got ${adapters.length}`);
  for (const a of adapters) {
    assert.ok(a.id, `adapter missing id: ${JSON.stringify(a).slice(0, 200)}`);
    assert.ok(typeof a.compute === 'function', `adapter ${a.id} missing compute()`);
  }
});

test('registry resolves known protocols', () => {
  const adapters = loadAllAdapters();
  const cases = [
    { protocol_name: 'Aave V3',           protocol_canonical: 'aave',        expectId: 'aave' },
    { protocol_name: 'Morpho',            protocol_canonical: 'morpho',      expectId: 'morpho' },
    { protocol_name: 'Euler',             protocol_canonical: 'euler',       expectId: 'euler' },
    { protocol_name: 'Fluid',             protocol_canonical: 'fluid',       expectId: 'fluid' },
    { protocol_name: 'Curve',             protocol_canonical: 'curve',       expectId: 'curve' },
    { protocol_name: 'Wallet',            protocol_canonical: 'wallet-held', expectId: 'wallet' },
    { protocol_name: 'yoUSD',             protocol_canonical: 'yousd',       expectId: 'ybs' },
    { protocol_name: 'ethena-usde',       protocol_canonical: 'ethena',      expectId: 'ybs' },
    { protocol_name: 'Maple Institutional', protocol_canonical: 'maple',     expectId: 'offchain' },
    { protocol_name: 'Private Reinsurance Deals', protocol_canonical: 'reinsurance', expectId: 'offchain' },
    { protocol_name: 'MMZ20240501ZZZ500', protocol_canonical: 'reins-deal',  expectId: 'offchain' },
    { protocol_name: 'Dolomite',          protocol_canonical: 'dolomite',    expectId: 'single-venue' },
    { protocol_name: 'Pendle',            protocol_canonical: 'pendle',      expectId: 'pendle' },
    { protocol_name: 'RandomNewThing',    protocol_canonical: 'randomnewthing', expectId: 'unknown' },
  ];
  for (const c of cases) {
    const a = resolveAdapter(c, adapters);
    assert.ok(a, `no adapter resolved for ${c.protocol_name}`);
    assert.strictEqual(a.id, c.expectId, `${c.protocol_name}: expected ${c.expectId}, got ${a.id}`);
  }
});

test('validateRow rejects invalid rows', () => {
  assert.throws(() => validateRow({ kind: 'bad', source: 'onchain', confidence: 'high', usd: 1 }, 'x'));
  assert.throws(() => validateRow({ kind: 'primary_asset', source: 'bogus', confidence: 'high', usd: 1 }, 'x'));
  assert.throws(() => validateRow({ kind: 'primary_asset', source: 'onchain', confidence: 'maybe', usd: 1 }, 'x'));
  assert.throws(() => validateRow({ kind: 'primary_asset', source: 'onchain', confidence: 'high', usd: 'n/a' }, 'x'));
  // valid
  validateRow({ kind: 'primary_asset', source: 'onchain', confidence: 'high', usd: 100 }, 'x');
});

test('primaryAssetRow and opaqueRow and unknownRow shapes pass validation', () => {
  validateRow(primaryAssetRow({ symbol: 'USDC', usd: 100 }), 'x');
  validateRow(opaqueRow({ venue: 'Maple', counterparty: 'Maven 11', usd: 1_000_000, attestationUrl: 'https://...' }), 'x');
  validateRow(unknownRow({ usd: 1000, reason: 'test' }), 'x');
});

test('unknown adapter always returns a row', async () => {
  const unk = require('../../src/exposure/adapters/unknown');
  const rows = await unk.compute({ net_usd: 1000, protocol_name: 'X', protocol_canonical: 'x', chain: 'eth' });
  assert.ok(Array.isArray(rows) && rows.length === 1);
  assert.strictEqual(rows[0].kind, 'unknown');
});

if (process.exitCode) {
  console.log('\nFAILED');
  process.exit(process.exitCode);
} else {
  console.log('\nAll tests passed.');
}
