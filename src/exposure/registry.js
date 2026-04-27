/**
 * Adapter registry — maps a position's protocol to its decomposition adapter.
 *
 * Resolution order:
 *   1. adapter.match(position) === true (full function)
 *   2. adapter.protocol_canonicals contains position.protocol_canonical
 *   3. adapter.protocol_names contains position.protocol_name (case-insensitive)
 *
 * First match wins. If nothing matches, we fall back to the 'unknown' adapter.
 */

const path = require('path');
const fs = require('fs');

function loadAllAdapters() {
  const dir = path.join(__dirname, 'adapters');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('_'));
  const adapters = [];
  for (const f of files) {
    const mod = require(path.join(dir, f));
    if (!mod || !mod.id) continue;
    adapters.push(mod);
  }
  return adapters;
}

function resolveAdapter(position, adapters) {
  const pname = String(position.protocol_name || '').toLowerCase();
  const pcan  = String(position.protocol_canonical || '').toLowerCase();

  for (const a of adapters) {
    if (typeof a.match === 'function') {
      try { if (a.match(position)) return a; } catch {}
    }
    if ((a.protocol_canonicals || []).some(c => String(c).toLowerCase() === pcan)) return a;
    if ((a.protocol_names || []).some(n => String(n).toLowerCase() === pname)) return a;
  }
  // hard fallback
  return adapters.find(a => a.id === 'unknown') || null;
}

module.exports = { loadAllAdapters, resolveAdapter };
