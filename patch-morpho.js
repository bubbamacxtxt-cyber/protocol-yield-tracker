const fs = require('fs');
const code = fs.readFileSync('/home/node/.openclaw/workspace/protocol-yield-tracker/src/fetch-base-apy.js', 'utf8');

// Add symbol mapping after the "if (!symbol) continue;" line in fetchMorphoApy
const search = 'if (!symbol) continue;\n        // Use daily average APY';
const replace = 'if (!symbol) continue;\n        // Map Morpho special symbols (USD℩0 -> USDT0)\n        if (symbol.includes("\u2129")) symbol = symbol.replace("\u2129", "T");\n        // Use daily average APY';

if (code.includes(search)) {
  const patched = code.replace(search, replace);
  fs.writeFileSync('/home/node/.openclaw/workspace/protocol-yield-tracker/src/fetch-base-apy.js', patched);
  console.log('patched');
} else {
  console.log('search pattern not found');
}
