#!/usr/bin/env node
/**
 * fetch-base-apy.js
 * Assigns apy_base to every supply token in positions.
 *
 * Resolution order:
 * 1. YBS list → yield-bearing stables with native yield
 * 2. Vaults table → upGAMMAusdc, hgETH, etc.
 * 3. Pendle PT/YT → impliedApy (PT), ytFloatingApy (YT)
 * 4. Protocol supply APY → Aave/Morpho/Euler supply rates (per-position)
 * 5. Euler → Euler Indexer API (indexer.euler.finance)
 * 6. Non-yield stables → 0% (or Aave reference rate)
 * 7. Static entries → tokens with known fixed rates
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const STABLES_PATH = path.join(__dirname, '..', 'data', 'stables.json');

const AAVE_CHAINS = [1, 42161, 8453, 9745, 5000, 56, 146, 57073];  // Ink
const MORPHO_CHAINS = [1, 42161, 8453, 5000, 56, 146, 10, 999, 143];  // 999=HyperEVM, 143=Monad
const PENDLE_CHAINS = [
  { id: 1, name: 'eth' },
  { id: 9745, name: 'plasma' },
  { id: 42161, name: 'arb' },
  { id: 8453, name: 'base' },
];

const CHAIN_ID_MAP = {
  eth: 1, ethereum: 1,
  arb: 42161, arbitrum: 42161,
  base: 8453,
  plasma: 9745,
  mnt: 5000, mantle: 5000,
  bsc: 56,
  sonic: 146,
  avax: 43114, avalanche: 43114,
  op: 10, optimism: 10,
  monad: 143,
  hyper: 999,
  ink: 57073,
};
// Morpho uses different chain IDs for some chains

// ─── Source 1: YBS List ────────────────────────────────────────────
function loadYbsApy() {
  const data = JSON.parse(fs.readFileSync(STABLES_PATH, 'utf8'));
  const map = {};
  for (const s of data.stables) {
    map[s.name] = s.aprValue || parseFloat(s.apr) || 0;
  }
  return map;
}

// ─── Source 2: Vaults table ───────────────────────────────────────
function loadVaultApy(db) {
  const map = {};
  const rows = db.prepare("SELECT symbol, apy_30d FROM vaults WHERE apy_30d IS NOT NULL AND apy_30d > 0").all();
  for (const r of rows) map[r.symbol] = r.apy_30d;
  return map;
}

// ─── Source 3: Pendle PT/YT ───────────────────────────────────────
async function fetchPendleApy() {
  const map = {};
  for (const c of PENDLE_CHAINS) {
    try {
      const res = await fetch(`https://api-v2.pendle.finance/core/v1/${c.id}/markets?is_expired=false&limit=100`);
      if (!res.ok) continue;
      const d = await res.json();
      const markets = d.results || [];
      for (const m of markets) {
        if (m.pt?.symbol) {
          map[m.pt.symbol] = {
            apy: (m.impliedApy || 0) * 100,
            underlyingApy: (m.underlyingApy || 0) * 100,
            chain: c.name,
          };
        }
        if (m.yt?.symbol) {
          map[m.yt.symbol] = {
            apy: (m.ytFloatingApy || 0) * 100,
            underlyingApy: (m.underlyingApy || 0) * 100,
            chain: c.name,
          };
        }
      }
      process.stdout.write(`  Pendle chain ${c.name}: ${markets.length} markets\r`);
    } catch (e) {
      console.log(`  ❌ Pendle chain ${c.name}: ${e.message}`);
    }
  }
  console.log(`  Pendle: ${Object.keys(map).length} PT/YT tokens with APY     `);
  return map;
}

// ─── Source 4: Aave V3 APY (1-day average) ────────────────────────
async function fetchAaveApy() {
  const supplyMap = {};
  const borrowMap = {};
  for (const cid of AAVE_CHAINS) {
    const query = `{ markets(request: { chainIds: [${cid}] }) { reserves { underlyingToken { symbol address } market { address } supplyInfo { apy { formatted } } borrowInfo { apy { formatted } } } } }`;
    try {
      const res = await fetch('https://api.v3.aave.com/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const d = await res.json();
      const mkts = d?.data?.markets || [];
      const allReserves = mkts.flatMap(m => m.reserves || []);
      for (const r of allReserves) {
        const symbol = r.underlyingToken?.symbol;
        if (!symbol) continue;
        const tokenAddr = r.underlyingToken?.address;
        const poolAddr = r.market?.address;
        let sApy = parseFloat(r.supplyInfo?.apy?.formatted || '0');
        let bApy = parseFloat(r.borrowInfo?.apy?.formatted || '0');
        // Try 1-day average from history
        if (tokenAddr && poolAddr) {
          try {
            const hq = `{ supply: supplyAPYHistory(request: { chainId: ${cid}, underlyingToken: "${tokenAddr}", market: "${poolAddr}", window: LAST_DAY }) { avgRate { formatted } } borrow: borrowAPYHistory(request: { chainId: ${cid}, underlyingToken: "${tokenAddr}", market: "${poolAddr}", window: LAST_DAY }) { avgRate { formatted } } }`;
            const hr = await fetch('https://api.v3.aave.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: hq }) });
            const hd = await hr.json();
            const ss = hd?.data?.supply || []; const bs = hd?.data?.borrow || [];
            if (ss.length > 0) sApy = ss.reduce((a, x) => a + parseFloat(x.avgRate?.formatted || '0'), 0) / ss.length;
            if (bs.length > 0) bApy = bs.reduce((a, x) => a + parseFloat(x.avgRate?.formatted || '0'), 0) / bs.length;
          } catch (e) {}
        }
        if (sApy > 0) {
          if (!supplyMap[symbol]) supplyMap[symbol] = {};
          supplyMap[symbol][cid] = Math.max(supplyMap[symbol][cid] || 0, sApy);
        }
        if (bApy > 0) {
          if (!borrowMap[symbol]) borrowMap[symbol] = {};
          borrowMap[symbol][cid] = Math.max(borrowMap[symbol][cid] || 0, bApy);
        }
      }
      process.stdout.write(`  Aave chain ${cid}: ${allReserves.length} reserves\r`);
    } catch (e) {
      console.log(`  ❌ Aave chain ${cid}: ${e.message}`);
    }
  }
  console.log(`  Aave: ${Object.keys(supplyMap).length} supply, ${Object.keys(borrowMap).length} borrow tokens       `);
  return { supply: supplyMap, borrow: borrowMap };
}

// ─── Source 5: Morpho APY ─────────────────────────────────────────
async function fetchMorphoApy() {
  const supplyMap = {};
  const borrowMap = {};
  const byMarketId = {};  // marketId -> { supplyApy, borrowApy }
  for (const cid of MORPHO_CHAINS) {
    const query = `{ markets(where: { chainId_in: [${cid}] }, first: 1000) { items { marketId loanAsset { symbol } state { supplyApy borrowApy dailySupplyApy dailyBorrowApy } } } }`;
    try {
      const res = await fetch('https://api.morpho.org/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const d = await res.json();
      const items = d?.data?.markets?.items || [];
      for (const m of items) {
        let symbol = m.loanAsset?.symbol;
        if (!symbol) continue;
        // Map Morpho special symbols (USD₮0 -> USDT0)
        if (symbol.includes("₮")) symbol = symbol.replace("₮", "T");
        // Use daily average APY (more stable than instantaneous)
        const sApy = (m.state?.dailySupplyApy ?? m.state?.supplyApy ?? 0) * 100;
        const bApy = (m.state?.dailyBorrowApy ?? m.state?.borrowApy ?? 0) * 100;
        // Store by market ID for precise lookups
        if (m.marketId) {
          byMarketId[m.marketId.toLowerCase()] = { supplyApy: sApy, borrowApy: bApy };
        }
        // Skip broken/abnormal markets (bogus APYs > 100% daily are not real)
        if (sApy > 100 || bApy > 100) {
          if (bApy > 1000) console.log(`  ⚠️ Skipping broken market: ${m.collateralAsset?.symbol}->${symbol} borrow ${(bApy).toFixed(0)}%`);
          continue;
        }
        if (sApy > 0) {
          if (!supplyMap[symbol]) supplyMap[symbol] = {};
          supplyMap[symbol][cid] = Math.max(supplyMap[symbol][cid] || 0, sApy);
        }
        if (bApy > 0) {
          if (!borrowMap[symbol]) borrowMap[symbol] = {};
          borrowMap[symbol][cid] = Math.max(borrowMap[symbol][cid] || 0, bApy);
        }
      }
      process.stdout.write(`  Morpho chain ${cid}: ${items.length} markets\r`);
    } catch (e) {
      console.log(`  ❌ Morpho chain ${cid}: ${e.message}`);
    }
  }
  console.log(`  Morpho: ${Object.keys(supplyMap).length} supply, ${Object.keys(borrowMap).length} borrow, ${Object.keys(byMarketId).length} markets      `);
  return { supply: supplyMap, borrow: borrowMap, byMarketId, missingMarketIds: new Set() };
}

// Query Morpho directly for a specific market ID (fallback for markets not in bulk query)
async function queryMorphoMarketDirect(marketId, chainId) {
  try {
    const query = `{ marketById(marketId: "${marketId}", chainId: ${chainId}) { marketId loanAsset { symbol } collateralAsset { symbol } state { dailyBorrowApy dailySupplyApy } } }`;
    const res = await fetch('https://api.morpho.org/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    const m = data?.data?.marketById;
    if (m?.state) {
      return {
        supplyApy: (m.state.dailySupplyApy ?? 0) * 100,
        borrowApy: (m.state.dailyBorrowApy ?? 0) * 100
      };
    }
  } catch (e) {}
  return null;
}

// Query Morpho for markets by collateral+loan addresses (for positions without market ID)
async function queryMorphoMarketsByTokens(collateralAddr, loanAddr, chainId) {
  try {
    // Query markets and filter client-side (GraphQL address filters unreliable)
    const query = `{ markets(where: { chainId_in: [${chainId}] }, first: 500) { items { marketId loanAsset { address symbol } collateralAsset { address symbol } state { dailyBorrowApy dailySupplyApy } } } }`;
    const res = await fetch('https://api.morpho.org/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    const items = data?.data?.markets?.items || [];
    // Find matching market by both addresses
    const match = items.find(m => 
      m.collateralAsset?.address?.toLowerCase() === collateralAddr?.toLowerCase() &&
      m.loanAsset?.address?.toLowerCase() === loanAddr?.toLowerCase()
    );
    if (match?.state) {
      return {
        marketId: match.marketId,
        supplyApy: (match.state.dailySupplyApy ?? 0) * 100,
        borrowApy: (match.state.dailyBorrowApy ?? 0) * 100
      };
    }
  } catch (e) { console.log(`  Token query error: ${e.message}`); }
  return null;
}

// Normalize symbols: USD₮0 -> USDT0 (for map lookups)
function normSymbol(sym) {
  if (!sym) return sym;
  return sym.includes('₮') ? sym.replace('₮', 'T') : sym;
}

// ─── Source 6: Euler v2 APY (via Euler Indexer API) ─────────────────
async function fetchEulerApy() {
  const bestVault = {};
  const chainIds = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 146: 'sonic', 9745: 'plasma' };
  for (const [cid, name] of Object.entries(chainIds)) {
    try {
      const res = await fetch('https://indexer.euler.finance/v2/vault/list?chainId=' + cid + '&take=200');
      if (!res.ok) { console.log('  ❌ Euler ' + name + ': HTTP ' + res.status); continue; }
      const data = await res.json();
      const items = data.items || [];
      for (const v of items) {
        const symbol = v.assetSymbol;
        if (!symbol) continue;
        const sApy = v.supplyApy && v.supplyApy.totalApy != null ? v.supplyApy.totalApy : 0;
        const bApy = v.borrowApy && v.borrowApy.totalApy != null ? v.borrowApy.totalApy : 0;
        const tvl = v.totalAssetsUSD || 0;
        const key = symbol + ':' + cid;
        if (!bestVault[key] || tvl > bestVault[key].tvl) {
          bestVault[key] = { supplyApy: sApy, borrowApy: bApy, tvl: tvl };
        }
      }
      console.log('  Euler ' + name + ': ' + items.length + ' vaults');
    } catch (e) {
      console.log('  ❌ Euler ' + name + ': ' + e.message);
    }
  }
  const supplyMap = {}, borrowMap = {};
  for (const [key, v] of Object.entries(bestVault)) {
    const parts = key.split(':');
    const symbol = parts[0], cid = parts[1];
    if (v.supplyApy > 0) {
      if (!supplyMap[symbol]) supplyMap[symbol] = {};
      supplyMap[symbol][cid] = v.supplyApy;
    }
    if (v.borrowApy > 0) {
      if (!borrowMap[symbol]) borrowMap[symbol] = {};
      borrowMap[symbol][cid] = v.borrowApy;
    }
  }
  console.log('  Euler: ' + Object.keys(supplyMap).length + ' supply, ' + Object.keys(borrowMap).length + ' borrow');
  return { supply: supplyMap, borrow: borrowMap };
}

// ─── Main// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const db = new Database(DB_PATH);

  try { db.exec("ALTER TABLE position_tokens ADD COLUMN apy_base REAL DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE position_tokens ADD COLUMN apy_base_source TEXT DEFAULT NULL"); } catch {}

  console.log('=== Fetching Base APY ===\n');

  // Fetch all sources
  console.log('1. YBS list...');
  const ybs = loadYbsApy();
  console.log(`   ${Object.keys(ybs).length} tokens`);

  console.log('2. Vaults table...');
  const vaults = loadVaultApy(db);
  console.log(`   ${Object.keys(vaults).length} vaults`);

  console.log('3. Pendle PT/YT...');
  const pendleApy = await fetchPendleApy();

  console.log('4. Aave V3 APY...');
  const aaveApy = await fetchAaveApy();

  console.log('5. Morpho APY...');
  const morphoApy = await fetchMorphoApy();

  console.log('6. Euler v2 APY (Indexer API)...');
  const eulerApy = await fetchEulerApy();

  // ── Apply supply APY ──────────────────────────────────────────
  console.log('\n6. Applying supply APY...');

  const nonYieldStables = new Set(['USDC', 'USDT', 'PYUSD', 'GHO', 'USDT0', 'AUSD', 'USDS', 'RLUSD', 'USDe', 'NUSD', 'rUSD', 'USD1', 'VBILL', 'USDai']);
  const staticApy = {
    'weETH': 3.0, 'iUSD': 4.5, 'crvUSD': 0, 'USDO': 4.0,
    'RLP': 0, 'PENDLE': 0, 'CRV': 0, 'CVX': 0, 'YB': 0,
  };

  // Step 1: Token-level (YBS, vaults, Pendle)
  const tokens = db.prepare("SELECT DISTINCT symbol FROM position_tokens WHERE role='supply'").all();
  let ybsCount = 0, vaultCount = 0, pendleCount = 0;

  for (const t of tokens) {
    if (ybs[t.symbol] != null) {
      db.prepare("UPDATE position_tokens SET apy_base = ?, apy_base_source = 'ybs' WHERE symbol = ? AND role='supply'")
        .run(ybs[t.symbol], t.symbol);
      ybsCount++;
    } else if (vaults[t.symbol] != null) {
      db.prepare("UPDATE position_tokens SET apy_base = ?, apy_base_source = 'vault' WHERE symbol = ? AND role='supply'")
        .run(vaults[t.symbol], t.symbol);
      vaultCount++;
    } else if (pendleApy[t.symbol] != null) {
      db.prepare("UPDATE position_tokens SET apy_base = ?, apy_base_source = 'pendle' WHERE symbol = ? AND role='supply'")
        .run(pendleApy[t.symbol].apy, t.symbol);
      pendleCount++;
    }
  }
  console.log(`   Token-level: YBS: ${ybsCount}, Vaults: ${vaultCount}, Pendle: ${pendleCount}`);

  // Step 2: Protocol-level (Aave, Morpho, static, non-yield)
  const pending = db.prepare(`
    SELECT pt.id, pt.position_id, pt.symbol, pt.address as supply_address,
           p.protocol_name, p.chain, p.position_index,
           pm.market_id as morpho_market_id,
           (SELECT address FROM position_tokens WHERE position_id = p.id AND role = 'borrow' LIMIT 1) as borrow_address
    FROM position_tokens pt JOIN positions p ON pt.position_id = p.id
    LEFT JOIN position_markets pm ON pm.position_id = p.id AND pm.protocol = 'Morpho'
    WHERE pt.role='supply' AND pt.apy_base IS NULL
  `).all();

  let staticApplied = 0, aaveApplied = 0, morphoApplied = 0, eulerApplied = 0, zeroCount = 0, stillMissing = 0;

  for (const row of pending) {
    const cid = CHAIN_ID_MAP[row.chain?.toLowerCase()] || CHAIN_ID_MAP[row.chain?.toLowerCase()] || 0;
    let apy = null, source = null;

    if (staticApy[row.symbol] != null) {
      apy = staticApy[row.symbol]; source = 'static'; staticApplied++;
    } else if (row.protocol_name === 'Aave V3' && aaveApy.supply[row.symbol]?.[cid] != null) {
      apy = aaveApy.supply[row.symbol][cid]; source = 'aave_supply'; aaveApplied++;
    } else if (row.protocol_name === 'Morpho') {
      // Try market-specific rate first (from position_markets)
      const marketId = row.morpho_market_id?.toLowerCase();
      if (marketId && morphoApy.byMarketId[marketId]?.supplyApy > 0) {
        apy = morphoApy.byMarketId[marketId].supplyApy; source = 'morpho_supply'; morphoApplied++;
      } else if (morphoApy.supply[normSymbol(row.symbol)]?.[cid] != null) {
        apy = morphoApy.supply[normSymbol(row.symbol)][cid]; source = 'morpho_supply'; morphoApplied++;
      } else if (row.borrow_address && cid > 0) {
        // Last resort: query Morpho by token addresses
        const tokenResult = await queryMorphoMarketsByTokens(row.supply_address, row.borrow_address, cid);
        if (tokenResult?.supplyApy > 0) {
          apy = tokenResult.supplyApy; source = 'morpho_supply_addr'; morphoApplied++;
          if (tokenResult.marketId) {
            morphoApy.byMarketId[tokenResult.marketId.toLowerCase()] = tokenResult;
            db.prepare("INSERT OR REPLACE INTO position_markets (position_id, protocol, chain, market_id, underlying_token, source) VALUES (?, ?, ?, ?, ?, ?)")
              .run(row.position_id, 'Morpho', row.chain, tokenResult.marketId, row.supply_address, 'apy-fetch');
          }
        }
      }
    } else if (row.protocol_name === 'Euler' && eulerApy.supply[row.symbol]?.[cid] != null) {
      apy = eulerApy.supply[row.symbol][cid]; source = 'euler_supply'; eulerApplied++;
    } else if (nonYieldStables.has(row.symbol)) {
      // Try Aave reference rate first
      if (aaveApy.supply[row.symbol]?.[cid] != null) {
        apy = aaveApy.supply[row.symbol][cid]; source = 'aave_supply_ref'; aaveApplied++;
      } else if (aaveApy.supply[row.symbol]?.[1] != null) {
        apy = aaveApy.supply[row.symbol][1]; source = 'aave_supply_ref'; aaveApplied++;
      } else {
        apy = 0; source = 'non-yield'; zeroCount++;
      }
    }

    if (apy != null) {
      db.prepare("UPDATE position_tokens SET apy_base = ?, apy_base_source = ? WHERE id = ?").run(apy, source, row.id);
    } else {
      stillMissing++;
    }
  }
  console.log(`   Protocol-level: Static: ${staticApplied}, Aave: ${aaveApplied}, Morpho: ${morphoApplied}, Euler: ${eulerApplied}, Zero: ${zeroCount}, Missing: ${stillMissing}`);

  // ── Apply borrow APY (cost) ───────────────────────────────────
  console.log('\n7. Applying borrow APY...');
  const borrowTokens = db.prepare("SELECT DISTINCT symbol FROM position_tokens WHERE role='borrow' AND apy_base IS NULL").all();
  let borrowAave = 0, borrowMorpho = 0, borrowRef = 0, borrowZero = 0, borrowMiss = 0;

  // Token-level: same as supply but for borrow role
  for (const t of borrowTokens) {
    // Non-yield stables still have borrow rates
    // Try Aave borrow rate
    // For now, assign per-position
  }

  const borrowPending = db.prepare(`
    SELECT pt.id, pt.position_id, pt.symbol, pt.address as borrow_address,
           p.protocol_name, p.chain, p.position_index,
           pm.market_id as morpho_market_id,
           (SELECT address FROM position_tokens WHERE position_id = p.id AND role = 'supply' LIMIT 1) as supply_address
    FROM position_tokens pt JOIN positions p ON pt.position_id = p.id
    LEFT JOIN position_markets pm ON pm.position_id = p.id AND pm.protocol = 'Morpho'
    WHERE pt.role='borrow' AND pt.apy_base IS NULL
  `).all();

  for (const row of borrowPending) {
    const cid = CHAIN_ID_MAP[row.chain?.toLowerCase()] || CHAIN_ID_MAP[row.chain?.toLowerCase()] || 0;
    let apy = null, source = null;

    if (row.protocol_name === 'Aave V3' && aaveApy.borrow[row.symbol]?.[cid] != null) {
      apy = aaveApy.borrow[row.symbol][cid]; source = 'aave_borrow'; borrowAave++;
    } else if (row.protocol_name === 'Morpho') {
      const marketId = row.morpho_market_id?.toLowerCase();
      if (marketId && morphoApy.byMarketId[marketId]?.borrowApy > 0) {
        // Found in bulk query by market ID
        apy = morphoApy.byMarketId[marketId].borrowApy; source = 'morpho_borrow'; borrowMorpho++;
      } else if (marketId && cid > 0) {
        // Market ID exists but not in bulk query - query directly
        const direct = await queryMorphoMarketDirect(marketId, cid);
        if (direct != null && direct.borrowApy != null) {
          apy = direct.borrowApy; source = 'morpho_borrow'; borrowMorpho++;
          morphoApy.byMarketId[marketId] = direct;
        }
      }
      // If still no APY, try token-based query (more accurate than symbol+chain max)
      if (apy == null && row.borrow_address && row.supply_address && cid > 0) {
        const tokenResult = await queryMorphoMarketsByTokens(row.supply_address, row.borrow_address, cid);
        if (tokenResult != null && tokenResult.borrowApy != null) {
          apy = tokenResult.borrowApy; source = 'morpho_borrow_addr'; borrowMorpho++;
          if (tokenResult.marketId) {
            morphoApy.byMarketId[tokenResult.marketId.toLowerCase()] = tokenResult;
            db.prepare("INSERT OR REPLACE INTO position_markets (position_id, protocol, chain, market_id, underlying_token, source) VALUES (?, ?, ?, ?, ?, ?)")
              .run(row.position_id, 'Morpho', row.chain, tokenResult.marketId, row.supply_address, 'apy-fetch');
          }
        }
      }
      // Last resort: symbol+chain max rate (WARNING: may be inaccurate for non-specific markets)
      if (apy == null && morphoApy.borrow[normSymbol(row.symbol)]?.[cid] != null) {
        apy = morphoApy.borrow[normSymbol(row.symbol)][cid]; source = 'morpho_borrow_max'; borrowMorpho++;
      }
    } else if (aaveApy.borrow[row.symbol]?.[cid] != null) {
      // Use Aave as reference for other protocols
      apy = aaveApy.borrow[row.symbol][cid]; source = 'aave_borrow_ref'; borrowRef++;
    } else if (aaveApy.borrow[row.symbol]?.[1] != null) {
      apy = aaveApy.borrow[row.symbol][1]; source = 'aave_borrow_ref'; borrowRef++;
    } else {
      borrowMiss++;
    }

    if (apy != null) {
      db.prepare("UPDATE position_tokens SET apy_base = ?, apy_base_source = ? WHERE id = ?").run(apy, source, row.id);
    }
  }
  console.log(`   Borrow: Aave: ${borrowAave}, Morpho: ${borrowMorpho}, Ref: ${borrowRef}, Missing: ${borrowMiss}`);

  // ── Summary ────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  const totalSupply = db.prepare("SELECT COUNT(*) as c FROM position_tokens WHERE role='supply'").get();
  const coveredSupply = db.prepare("SELECT COUNT(*) as c FROM position_tokens WHERE role='supply' AND apy_base IS NOT NULL").get();
  const totalBorrow = db.prepare("SELECT COUNT(*) as c FROM position_tokens WHERE role='borrow'").get();
  const coveredBorrow = db.prepare("SELECT COUNT(*) as c FROM position_tokens WHERE role='borrow' AND apy_base IS NOT NULL").get();
  console.log(`Supply APY: ${coveredSupply.c}/${totalSupply.c} (${(coveredSupply.c / totalSupply.c * 100).toFixed(1)}%)`);
  console.log(`Borrow APY: ${coveredBorrow.c}/${totalBorrow.c} (${(coveredBorrow.c / totalBorrow.c * 100).toFixed(1)}%)`);
  const bySource = db.prepare("SELECT apy_base_source, role, COUNT(*) as c FROM position_tokens WHERE apy_base IS NOT NULL GROUP BY apy_base_source, role ORDER BY c DESC").all();
  bySource.forEach(s => console.log(`  ${s.apy_base_source || 'null'} (${s.role}): ${s.c}`));

  if (stillMissing > 0 || borrowMiss > 0) {
    console.log('\nStill missing APY:');
    const missing = db.prepare(`
      SELECT pt.symbol, pt.role, p.protocol_name, p.chain, SUM(pt.value_usd) as total_usd
      FROM position_tokens pt JOIN positions p ON pt.position_id = p.id
      WHERE pt.apy_base IS NULL
      GROUP BY pt.symbol, pt.role, p.protocol_name ORDER BY total_usd DESC LIMIT 20
    `).all();
    missing.forEach(m => console.log(`  ${m.symbol.padEnd(20)} ${m.role.padEnd(8)} ${m.protocol_name.padEnd(15)} ${m.chain.padEnd(10)} $${(m.total_usd / 1e6).toFixed(2)}M`));
  }

  db.close();
}

main().catch(e => console.error(e));
