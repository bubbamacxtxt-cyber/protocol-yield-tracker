/**
 * Off-chain opaque positions.
 *
 * Matches the class of "we have a USD number, we know the counterparty, we
 * can't trustlessly decompose further." For these we emit a single
 * opaque_offchain row with counterparty + attestation (when available).
 *
 * Covered:
 *   - Private Reinsurance Deals (counterparty known, attestation private)
 *   - Fasanara mGLOBAL (GDADF), Fasanara Genesis Fund, Fasanara Digital
 *   - Maple Institutional (has public pool data → TODO: recurse once maple adapter lands)
 *   - Deal IDs: MMZ*, HLF*, BYZ*, ICM*, SPR*, SPS* (reinsurance CUSIP-ish)
 *   - RockawayX, Adaptive Frontier (private funds)
 *
 * See docs/secondary-risk-coverage-plan.md §3.9.
 */

const { opaqueRow } = require('./_base');

const DEAL_PREFIX = /^(MMZ|HLF|BYZ|ICM|SPR|SPS)[A-Z0-9]+$/i;

const OPAQUE_MATCHERS = [
  { re: /^Private Reinsurance Deals$/i,          category: 'reinsurance', attestation: null },
  { re: /^Fasanara /i,                           category: 'credit-fund', attestation: 'https://www.fasanara.com/investor-letters' },
  { re: /^Maple Institutional$/i,                category: 'private-credit', attestation: 'https://api.maple.finance/v2/pools' },
  { re: /^RockawayX$/i,                          category: 'fund', attestation: 'https://rockawayx.com/' },
  { re: /^Adaptive Frontier$/i,                  category: 'fund', attestation: null },
];

function classify(protocolName) {
  if (DEAL_PREFIX.test(protocolName)) return { category: 'reinsurance-deal', attestation: null };
  for (const m of OPAQUE_MATCHERS) {
    if (m.re.test(protocolName)) return m;
  }
  return null;
}

module.exports = {
  id: 'offchain',
  protocol_names: [
    'Private Reinsurance Deals', 'Fasanara mGLOBAL (GDADF)', 'Fasanara Genesis Fund',
    'Fasanara Digital', 'Maple Institutional', 'RockawayX', 'Adaptive Frontier',
  ],
  confidence: 'medium',
  references: [
    'https://maple.finance/institutional',
    'https://www.fasanara.com/',
  ],
  match(position) {
    if (DEAL_PREFIX.test(position.protocol_name || '')) return true;
    return false; // else fall through to protocol_names match
  },
  async compute(position) {
    const cls = classify(position.protocol_name) || { category: 'unclassified-offchain', attestation: null };
    return [opaqueRow({
      venue: position.protocol_name,
      counterparty: position.protocol_name,
      usd: position.net_usd,
      attestationUrl: cls.attestation,
      note: `category=${cls.category}; decomposition requires first-party attestation`,
      asOf: position.scanned_at,
    })];
  },
};
