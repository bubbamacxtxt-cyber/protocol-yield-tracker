/**
 * Morpho Vault Exposure Lookthrough (v2 - REST API)
 *
 * For every scanner-detected Morpho position, fetch the vault's collateral
 * exposure data from the public REST API and compute pro-rata exposure.
 *
 * Data source: https://app.morpho.org/api/vaults (public, no auth)
 *
 * Returns lookthrough rows keyed by position_id.
 */

const MORPHO_VAULTS_API = 'https://app.morpho.org/api/vaults';

// Cache for vault exposure data keyed by vault address (lowercase)
let vaultExposureCache = null;
let lastFetch = 0;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Fetch all vaults and build exposure lookup map.
 * Returns Map<vaultAddressLowercase -> { asset, totalAssetsUsd, exposure[] }>
 */
async function fetchVaultExposures() {
  if (vaultExposureCache && (Date.now() - lastFetch) < CACHE_TTL_MS) {
    return vaultExposureCache;
  }

  console.log('[lookthrough] morpho-rest: fetching vault exposure data...');
  const allVaults = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const url = `${MORPHO_VAULTS_API}?skip=${skip}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[lookthrough] morpho-rest: API error ${res.status} at skip=${skip}`);
      break;
    }
    const data = await res.json();
    const items = data.items || [];
    const pageInfo = data.pageInfo || {};
    const countTotal = pageInfo.countTotal || items.length;
    
    allVaults.push(...items);
    console.log(`  [fetched page skip=${skip}, got ${items.length}/${countTotal} total]`);
    
    if (allVaults.length >= countTotal || items.length === 0) break;
    skip += items.length;
  }

  console.log(`[lookthrough] morpho-rest: fetched ${allVaults.length} vaults total`);

  // Build lookup by address
  const cache = new Map();
  for (const v of allVaults) {
    const key = v.address?.toLowerCase();
    if (key) {
      // Filter out idle exposures (null collateralAsset or 0%)
      const activeExposure = (v.exposure || []).filter(e => 
        e.collateralAsset && e.exposurePercent > 0.001
      );
      
      cache.set(key, {
        symbol: v.symbol || '???',
        asset: v.asset?.symbol || '???',
        totalAssetsUsd: v.totalAssetsUsd || 0,
        exposure: activeExposure,
      });
    }
  }

  vaultExposureCache = cache;
  lastFetch = Date.now();
  return cache;
}

/**
 * Compute lookthrough rows for Morpho positions.
 */
async function compute(positions, db) {
  console.time('[lookthrough] morpho-rest');

  const vaultMap = await fetchVaultExposures();
  const rows = [];
  let matched = 0;
  let missed = 0;

  // Build position-to-vault mapping from position_tokens
  for (const pos of positions) {
    const tokens = db.prepare(`
      SELECT DISTINCT address FROM position_tokens 
      WHERE position_id = ? AND role = 'supply' AND address LIKE '0x%'
    `).all(pos.id);

    let vaultFound = false;
    for (const token of tokens) {
      const vaultKey = token.address.toLowerCase();
      const vaultData = vaultMap.get(vaultKey);
      
      if (!vaultData) continue;
      vaultFound = true;
      matched++;

      const depositorAmount = pos.asset_usd;
      if (depositorAmount <= 0) continue;

      // Compute pro-rata exposure for each collateral in the vault
      let rankOrder = 0;
      for (const exp of vaultData.exposure) {
        rankOrder++;
        const proRataUsd = depositorAmount * exp.exposurePercent;

        rows.push({
          position_id: pos.id,
          kind: 'morpho_vault',
          market_key: `${exp.collateralAsset.address}-${pos.chain}`,
          collateral_symbol: exp.collateralAsset.symbol || '???',
          collateral_address: exp.collateralAsset.address || '',
          loan_symbol: vaultData.asset || '???',
          loan_address: '',
          chain: pos.chain,
          total_supply_usd: exp.exposureUSD || 0,
          total_borrow_usd: 0,
          utilization: 0,
          pro_rata_usd: proRataUsd,
          share_pct: vaultData.totalAssetsUsd > 0 
            ? (depositorAmount / vaultData.totalAssetsUsd) * 100 
            : 0,
          rank_order: rankOrder,
        });
      }
      break; // First matching vault is enough
    }

    if (!vaultFound) {
      missed++;
    }
  }

  console.log(`[lookthrough] morpho-rest: ${matched} positions matched, ${missed} vaults not found, ${rows.length} lookthrough rows`);
  console.timeEnd('[lookthrough] morpho-rest');

  return rows;
}

module.exports = { compute, fetchVaultExposures };
