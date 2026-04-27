/**
 * Morpho MetaMorpho Vault Lookthrough
 *
 * For every scanner-detected Morpho position (supply side), fetch the vault's
 * allocation to underlying markets and compute the depositor's pro-rata exposure
 * to each collateral.
 *
 * Data sources:
 *   - REST API: /api/positions/earn to get vault addresses per wallet
 *   - GraphQL: vaultByAddress to get allocation data
 *
 * NOTE: Morpho removed per-allocation USD amounts from the API (assetsUsd removed
 * from VaultAllocation type). We approximate using supplyCap proportions.
 *
 * Returns lookthrough rows keyed by position_id.
 */

const MORPHO_REST = 'https://app.morpho.org/api';
const MORPHO_GRAPHQL = 'https://app.morpho.org/api/graphql';

const ALL_CHAINS = [1, 8453, 42161, 137, 130, 747474, 999, 10, 143, 988, 480];

async function getEarnPositions(userAddress) {
  const url = `${MORPHO_REST}/positions/earn?userAddress=${userAddress}&limit=500&skip=0&chainIds=${ALL_CHAINS.join(',')}&orderBy=assetsUsd&orderDirection=DESC`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return (await res.json()).items || [];
  } catch { return []; }
}

async function getVaultAllocation(vaultAddress, chainId) {
  const query = `
  {
    vaultByAddress(address: "${vaultAddress}", chainId: ${chainId}) {
      name
      address
      symbol
      asset { symbol address decimals }
      allocation {
        market {
          uniqueKey
          collateralAsset { symbol address }
          loanAsset { symbol address }
        }
        supplyCap
      }
      state {
        totalAssetsUsd
      }
    }
  }
  `;

  const res = await fetch(MORPHO_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  
  // Debug: log the raw response for troubleshooting
  if (data.errors) {
    console.log(`[lookthrough] gql error: ${data.errors[0]?.message}`);
  }
  
  return data?.data?.vaultByAddress || null;
}

/**
 * Compute lookthrough rows for all Morpho scanner positions.
 * @param {Array} positions - rows from positions table where protocol_id = 'morpho'
 * @param {Object} db - better-sqlite3 db handle
 * @returns {Array} lookthrough rows to insert
 */
async function compute(positions, db) {
  console.time('[lookthrough] morpho');

  // Chain ID mapping
  const chainIdMap = { eth: 1, base: 8453, arb: 42161, poly: 137, opt: 10, mnt: 5000, blast: 81457, scroll: 534352, sonic: 146, plasma: 9745, uni: 130, wct: 747474, monad: 143, ink: 999, abstract: 2741 };

  // Get vault addresses from the DB (position_tokens.address for supply role)
  const vaultByPosition = new Map(); // position_id -> { vaultAddress, chainId }
  for (const pos of positions) {
    // Query position_tokens to get the vault address for this position
    const tokens = db.prepare(`
      SELECT address FROM position_tokens 
      WHERE position_id = ? AND role = 'supply' AND address LIKE '0x%' 
      LIMIT 1
    `).get(pos.id);
    
    if (tokens && tokens.address) {
      const chainId = chainIdMap[pos.chain.toLowerCase()] || 1;
      vaultByPosition.set(pos.id, { vaultAddress: tokens.address, chainId });
    }
  }
  
  console.log(`[lookthrough] morpho: ${positions.length} positions, ${vaultByPosition.size} with vault addresses`);

  // Group by vault and fetch allocation data
  const vaultCache = new Map(); // key: vaultAddr|chainId -> vaultData
  const rows = [];

  for (const [posId, vaultInfo] of vaultByPosition) {
    const vaultKey = `${vaultInfo.vaultAddress.toLowerCase()}|${vaultInfo.chainId}`;

    // Fetch vault allocation if not cached
    if (!vaultCache.has(vaultKey)) {
      console.log(`[lookthrough] morpho: fetching vault addr=${vaultInfo.vaultAddress} chain=${vaultInfo.chainId}`);
      try {
        const vaultData = await getVaultAllocation(vaultInfo.vaultAddress, vaultInfo.chainId);
        console.log(`[lookthrough] morpho:   -> ${vaultData ? `OK (${vaultData.symbol})` : 'NULL (not found)'}`);
        vaultCache.set(vaultKey, vaultData);
      } catch (e) {
        console.error(`[lookthrough] morpho: GraphQL failed for ${vaultInfo.vaultAddress}: ${e.message}`);
        vaultCache.set(vaultKey, null);
      }
    }

    const vaultData = vaultCache.get(vaultKey);
    if (!vaultData) continue;

    const pos = positions.find(p => p.id === posId);
    if (!pos) continue;

    const totalAssetsUsd = vaultData.state?.totalAssetsUsd || 0;
    if (totalAssetsUsd === 0) continue;

    const depositorAmount = pos.asset_usd;
    if (depositorAmount === 0) continue;

    const share = depositorAmount / totalAssetsUsd;

    // Parse supplyCap proportions
    const allocations = vaultData.allocation || [];
    let totalSupplyCap = 0;
    const allocsWithCap = [];
    for (const alloc of allocations) {
      const capRaw = alloc.supplyCap;
      if (!capRaw) continue;
      
      // supplyCap is a share-denominated cap (1e18 fixed-point or numeric)
      let cap;
      if (typeof capRaw === 'string') {
        const num = parseFloat(capRaw);
        cap = isFinite(num) ? num / 1e18 : 0;
      } else {
        cap = Number(capRaw) / 1e18;
      }
      
      if (!isFinite(cap) || cap <= 0) continue;
      allocsWithCap.push({ alloc, cap });
      totalSupplyCap += cap;
    }

    if (totalSupplyCap === 0) continue;

    let rankOrder = 0;
    for (const { alloc, cap } of allocsWithCap) {
      const market = alloc.market;
      if (!market || !market.collateralAsset) continue;

      const allocationProportion = cap / totalSupplyCap;
      const proRataUsd = depositorAmount * allocationProportion;

      rankOrder++;

      rows.push({
        position_id: pos.id,
        kind: 'morpho_vault',
        market_key: market.uniqueKey || `${market.collateralAsset.symbol || '?'}-${market.loanAsset?.symbol || '?'}`,
        collateral_symbol: market.collateralAsset.symbol || '?',
        collateral_address: market.collateralAsset.address || '',
        loan_symbol: market.loanAsset?.symbol || '?',
        loan_address: market.loanAsset?.address || '',
        chain: pos.chain,
        total_supply_usd: totalAssetsUsd * allocationProportion,
        total_borrow_usd: 0,
        utilization: 0,
        pro_rata_usd: proRataUsd,
        share_pct: share * 100,
        rank_order: rankOrder,
      });
    }
  }

  const vaultsCount = vaultCache.size;
  const vaultsSuccess = [...vaultCache.values()].filter(Boolean).length;
  console.log(`[lookthrough] morpho: ${vaultsCount} unique vaults, ${vaultsSuccess} fetched, ${rows.length} lookthrough rows`);
  console.timeEnd('[lookthrough] morpho');

  return rows;
}

module.exports = { compute, getVaultAllocation };
