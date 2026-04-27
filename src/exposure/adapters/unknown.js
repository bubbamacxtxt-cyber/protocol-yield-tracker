/**
 * Fallback adapter. Emits one `unknown` row so coverage audit can see the gap.
 * Never matched by registry; used as the default when resolveAdapter finds nothing.
 */

const { unknownRow } = require('./_base');

module.exports = {
  id: 'unknown',
  protocol_names: [],
  protocol_canonicals: [],
  confidence: 'low',
  references: [],
  async compute(position) {
    return [unknownRow({
      usd: position.net_usd,
      reason: `no adapter registered for protocol=${position.protocol_name} canonical=${position.protocol_canonical}`,
      protocol: position.protocol_name,
      chain: position.chain,
    })];
  },
};
