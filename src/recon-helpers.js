const fs = require('fs');
const path = require('path');

function loadActiveWalletChains(minUsd = 50000) {
  const p = path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-summary.json');
  if (!fs.existsSync(p)) return null;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const wallets = [];
  for (const w of (data.wallets || [])) {
    for (const c of (w.chains || [])) {
      if (!c.active_for_position_scan) continue;
      if (Number(c.total_usd || 0) < minUsd) continue;
      wallets.push({ whale: w.whale, vault: w.vault || null, wallet: w.wallet.toLowerCase(), chain: String(c.chain || '').toLowerCase(), total_usd: Number(c.total_usd || 0) });
    }
  }
  return wallets;
}

function loadWhaleWalletMap() {
  const p = path.join(__dirname, '..', 'data', 'whales.json');
  const whales = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rows = [];
  for (const [label, config] of Object.entries(whales)) {
    const addrs = Array.isArray(config) ? config : (config.vaults ? Object.values(config.vaults).flat() : []);
    for (const addr of addrs) rows.push({ addr: addr.toLowerCase(), label });
  }
  return rows;
}

module.exports = { loadActiveWalletChains, loadWhaleWalletMap };
