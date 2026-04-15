#!/usr/bin/env node
/**
 * vault-discoverer.js
 * 
 * Three-layer discovery system for protocol positions:
 * 
 * Layer 1: Protocol market scanning
 *   - Query protocol APIs for all markets
 *   - Check if wallet has positions in each market
 *   - Works for: Morpho (public + internal API), Euler, etc.
 * 
 * Layer 2: Token balance identification  
 *   - Get wallet's token balances via RPC (Transfer events)
 *   - Cross-reference with known vault registry
 *   - Probe unknowns for ERC-4626 interface
 * 
 * Layer 3: Merkl incentives enrichment
 *   - For found positions, check Merkl for additional rewards
 */

// ═══════════════════════════════════════════════════════════
// Morpho Market Scanner — find positions by checking all markets
// ═══════════════════════════════════════════════════════════

const MORPHO_PUBLIC = 'https://api.morpho.org/graphql';
const MORPHO_INTERNAL = 'https://app.morpho.org/api/graphql';
const MERKL_API = 'https://api.merkl.xyz/v4/opportunities';
const RPC_URL = 'https://eth.drpc.org';

// ─── Morpho Market Position Scanner ─────────────────────────
// Strategy: Get ALL Morpho markets, then check if wallet has
// supply/borrow position in each market via state query.

async function queryMorphoMarketsByLoanAsset(loanSymbol) {
  // Get all markets where loanAsset matches our target tokens
  // Use the public API (it lists markets, just not positions)
  const query = `{ markets(first:100) { items { marketId loanAsset { symbol address } collateralAsset { symbol address } state { supplyApy borrowApy } } } }`;
  
  const res = await fetch(MORPHO_PUBLIC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const text = await res.text();
  const data = JSON.parse(text);
  const items = data?.data?.markets?.items || [];
  if (items.length === 0 && text.includes('errors')) console.log('  GraphQL error for', loanSymbol, ':', JSON.parse(text).errors[0].message.slice(0,80));
  
  // Filter by loan asset and fix null state
  return items.filter(m => {
    const sym = (m.loanAsset?.symbol || '').toUpperCase();
    return loanSymbol.some(s => sym.includes(s));
  }).map(m => ({
    ...m,
    state: m.state || { supplyApy: 0, borrowApy: 0, totalSupplyUsd: 0, totalBorrowUsd: 0 }
  }));
}

// ─── Morpho Internal API: V2 Vault Performance ──────────────

const MORPHO_V2_PERF_HASH = '2450946f568dabb9e65946408befef7d15c529139e2a397c75bf64cbccf1aa9b';
const MORPHO_V2_EXPOSURE_HASH = '556eb959df1725ee4bcb84aab34a0a3b57d593875fe962f744a26c8d59b0b694';

async function getMorphoV2VaultPerformance(vaultAddr) {
  const res = await fetch(MORPHO_INTERNAL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-apollo-operation-name': 'GetVaultV2Performance' },
    body: JSON.stringify({
      operationName: 'GetVaultV2Performance',
      variables: { address: vaultAddr, chainId: 1 },
      extensions: { persistedQuery: { version: 1, sha256Hash: MORPHO_V2_PERF_HASH } }
    })
  });
  const text = await res.text();
  const data = JSON.parse(text);
  return data?.data?.vaultV2ByAddress || null;
}

async function getMorphoV2VaultExposure(vaultAddr) {
  const res = await fetch(MORPHO_INTERNAL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-apollo-operation-name': 'GetVaultV2Exposure' },
    body: JSON.stringify({
      operationName: 'GetVaultV2Exposure',
      variables: { address: vaultAddr, chainId: 1 },
      extensions: { persistedQuery: { version: 1, sha256Hash: MORPHO_V2_EXPOSURE_HASH } }
    })
  });
  const text = await res.text();
  const data = JSON.parse(text);
  return data?.data?.vaultV2ByAddress || null;
}

// ─── Morpho Market Position Check ───────────────────────────
// Check if wallet has supply/borrow in a specific Morpho market

async function checkMorphoMarketPosition(marketId, wallet) {
  // Morpho Blue position(user, id) is at a computed storage slot
  // Instead, use the Morpho public API: query userByAddress with marketPositions
  // But we know this returns empty for some wallets...
  // 
  // Alternative: use the internal API which might have better coverage
  
  // For now, check if the Morpho API returns any position for this market
  const query = `{ userByAddress(address:"${wallet}") { marketPositions { market { marketId } state { supplyAssetsUsd borrowAssetsUsd } } } }`;
  
  try {
    const res = await fetch(MORPHO_PUBLIC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const text = await res.text();
  const data = JSON.parse(text);
    const positions = data?.data?.userByAddress?.marketPositions || [];
    const match = positions.find(p => p.market?.marketId === marketId);
    if (match) {
      const s = match.state || {};
      return { supplyUsd: s.supplyAssetsUsd || 0, borrowUsd: s.borrowAssetsUsd || 0 };
    }
    return null;
  } catch { return null; }
}

// ─── Token Balance Scanner via Transfer Events ──────────────
// Instead of BalanceOf every vault, scan Transfer events TO the wallet
// to find which tokens (including vault shares) it has received.

const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function ethCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const text = await res.text();
  const data = JSON.parse(text);
  return data.result;
}

async function scanReceivedTokens(wallet, fromBlock, toBlock) {
  const walletTopic = '0x000000000000000000000000' + wallet.slice(2);
  
  const logs = await ethCall('eth_getLogs', [{
    topics: [TRANSFER_SIG, null, walletTopic],
    fromBlock: '0x' + fromBlock.toString(16),
    toBlock: '0x' + toBlock.toString(16)
  }]);
  
  // Deduplicate token addresses
  const tokens = new Map();
  for (const log of (logs || [])) {
    const addr = log.address.toLowerCase();
    if (!tokens.has(addr)) {
      tokens.set(addr, { address: addr, transfers: 0, lastBlock: 0 });
    }
    const t = tokens.get(addr);
    t.transfers++;
    t.lastBlock = Math.max(t.lastBlock, parseInt(log.blockNumber, 16));
  }
  
  return Array.from(tokens.values());
}

// ─── ERC-4626 Vault Probe ───────────────────────────────────
// Check if an address is an ERC-4626 vault by calling asset()

async function probeERC4626(vaultAddr) {
  // asset() selector = 0x52ef1b7d
  const result = await ethCall('eth_call', [{
    to: vaultAddr,
    data: '0x52ef1b7d'
  }, 'latest']);
  
  if (result && result !== '0x') {
    return '0x' + result.slice(-40); // Returns underlying asset address
  }
  return null;
}

async function getERC20Info(tokenAddr) {
  const [decResult, symResult] = await Promise.all([
    ethCall('eth_call', [{ to: tokenAddr, data: '0x313ce567' }, 'latest']),
    ethCall('eth_call', [{ to: tokenAddr, data: '0x95d89b41' }, 'latest'])
  ]);
  
  let decimals = 18;
  let symbol = 'UNKNOWN';
  
  if (decResult && decResult !== '0x') {
    decimals = parseInt(decResult, 16);
  }
  if (symResult && symResult !== '0x') {
    try {
      const len = parseInt(symResult.slice(66, 130), 16);
      symbol = Buffer.from(symResult.slice(130, 130 + len * 2), 'hex').toString();
    } catch {}
  }
  
  return { decimals, symbol };
}

// ─── Merkl Incentive Check ──────────────────────────────────

async function checkMerklRewards(vaultAddr) {
  try {
    const res = await fetch(`${MERKL_API}?chainId=1&identifier=${vaultAddr}&items=5`);
    const text = await res.text();
  const data = JSON.parse(text);
    if (Array.isArray(data) && data.length > 0) {
      const opp = data[0];
      return {
        apr: (opp.apr || 0) * 100,
        dailyRewards: opp.dailyRewards || 0,
        campaigns: opp.liveCampaigns || 0,
        earliestEnd: opp.earliestCampaignEnd,
        latestEnd: opp.latestCampaignEnd
      };
    }
  } catch {}
  return null;
}

// ═══════════════════════════════════════════════════════════
// Main Discovery Pipeline
// ═══════════════════════════════════════════════════════════

async function discoverPositions(wallet, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Discovering positions for ${label} (${wallet.slice(0,12)}...)`);
  console.log('='.repeat(60));
  
  const positions = [];
  
  // ── Step 1: Scan Morpho markets by loan asset ──────────
  console.log('\n📍 Step 1: Scanning Morpho markets...');
  
  const targetTokens = ['PYUSD', 'RLUSD', 'USDC', 'USDT', 'GHO'];
  const allMarkets = [];
  
  for (const token of targetTokens) {
    const markets = await queryMorphoMarketsByLoanAsset([token]);
    allMarkets.push(...markets);
    console.log(`  ${token}: ${markets.length} markets (supplyApy range: ${markets.map(m => m.state.supplyApy.toFixed(4)).join(', ')})`);
  }
  
  // Check each market for wallet positions
  console.log(`  Checking ${allMarkets.length} markets for positions...`);
  let foundMorpho = 0;
  
  for (const m of allMarkets) {
    const pos = await checkMorphoMarketPosition(m.marketId, wallet);
    if (pos && (pos.supplyUsd > 0 || pos.borrowUsd > 0)) {
      console.log(`    ✅ ${m.loanAsset?.symbol}/${m.collateralAsset?.symbol} supply=$${pos.supplyUsd}`);
      foundMorpho++;
      positions.push({
        protocol: 'Morpho',
        type: 'market',
        marketId: m.marketId,
        loanAsset: m.loanAsset?.symbol,
        collateralAsset: m.collateralAsset?.symbol,
        supplyUsd: pos.supplyUsd,
        borrowUsd: pos.borrowUsd,
        supplyApy: m.state?.supplyApy ? m.state.supplyApy * 100 : null,
        borrowApy: m.state?.borrowApy ? m.state.borrowApy * 100 : null
      });
    }
  }
  
  console.log(`  ✅ Found ${foundMorpho} Morpho market positions`);
  
  // Vault balanceOf scanning is done via chain-reader.js separately
  
  // ── Step 3: Enrich with Merkl rewards ──────────────────
  console.log('\n📍 Step 3: Checking Merkl incentives...');
  
  for (const pos of positions) {
    if (pos.marketId || pos.vault) {
      const addr = pos.vault || '';
      if (addr) {
        const merkl = await checkMerklRewards(addr);
        if (merkl && merkl.apr > 0) {
          pos.merklApr = merkl.apr;
          pos.merklDailyRewards = merkl.dailyRewards;
          console.log(`  ✅ ${pos.loanAsset || pos.symbol}: +${merkl.apr.toFixed(2)}% Merkl`);
        }
      }
    }
  }
  
  return positions;
}

// ─── Run ────────────────────────────────────────────────────

async function main() {
  const wallets = [
    { label: 'Reservoir', addr: '0x3063c5907faa10c01b242181aa689beb23d2bd65' },
    { label: 'Reservoir-2', addr: '0x289c204b35859bfb924b9c0759a4fe80f610671c' },
    { label: 'Makina', addr: '0xd1a1c248b253f1fc60eacd90777b9a63f8c8c1bc' },
  ];
  
  console.log('=== Vault Position Discovery ===\n');
  
  for (const w of wallets) {
    const positions = await discoverPositions(w.addr, w.label);
    
    console.log(`\n📊 ${w.label} Summary:`);
    if (positions.length === 0) {
      console.log('  No positions found (this may indicate the API gap we found earlier)');
    }
    for (const p of positions) {
      const supply = p.supplyUsd ? `$${p.supplyUsd.toLocaleString()}` : '-';
      const borrow = p.borrowUsd ? `$${p.borrowUsd.toLocaleString()}` : '-';
      const merkl = p.merklApr ? ` +${p.merklApr.toFixed(2)}% Merkl` : '';
      console.log(`  ${p.protocol} ${p.loanAsset}/${p.collateralAsset || '?'} supply=${supply} borrow=${borrow}${merkl}`);
    }
  }
}

// Export for use by other modules
module.exports = {
  discoverPositions,
  queryMorphoMarketsByLoanAsset,
  getMorphoV2VaultPerformance,
  getMorphoV2VaultExposure,
  checkMerklRewards,
  probeERC4626,
  getERC20Info,
  scanReceivedTokens
};

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
