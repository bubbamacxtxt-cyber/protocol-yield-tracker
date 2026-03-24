#!/usr/bin/env node
/**
 * Protocol Yield Tracker — Main Fetcher
 * Reads positions across Aave v3 and Morpho
 * Enriches with Portals APY data for yield-bearing tokens
 */

const fs = require('fs');
const Database = require('better-sqlite3');
const path = require('path');

const AAVE_GRAPHQL = 'https://api.v3.aave.com/graphql';
const MORPHO_GRAPHQL = 'https://api.morpho.org/graphql';
const PORTALS_API = 'https://api.portals.fi/v2/tokens';
const PORTALS_KEY = process.env.PORTALS_API_KEY;

// Load wallet list from wallets.json
function loadWallets() {
    const file = path.join(__dirname, '..', 'data', 'wallets.json');
    if (!fs.existsSync(file)) {
        console.error('Missing data/wallets.json — create it with your wallet list');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Generic GraphQL query with timeout
async function gql(endpoint, query, variables = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const payload = JSON.stringify({ query, variables });
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload,
            signal: controller.signal
        });
        const data = await res.json();
        return data.data || null;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Debug: log GraphQL errors to stderr
async function gqlDebug(endpoint, query, variables = {}) {
    const payload = JSON.stringify({ query, variables });
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload
    });
    const data = await res.json();
    if (data.errors) {
        const msgs = data.errors.map(e => e.message).join('; ');
        if (!msgs.includes('No results matching') && !msgs.includes('must have a selection')) {
            console.error(`  GraphQL: ${msgs.slice(0, 100)}`);
        }
    }
    return data.data || null;
}

// Get Aave v3 markets (pool addresses) for given chain IDs
async function getAaveMarkets(chainIds) {
    const QUERY = `
    query Markets($chainIds: [ChainId!]!) {
        markets(request: { chainIds: $chainIds }) {
            address
            name
            chain { name chainId }
            reserves {
                underlyingToken { symbol address decimals }
            }
        }
    }`;
    const data = await gql(AAVE_GRAPHQL, QUERY, { chainIds });
    return data?.markets || [];
}

// Get Aave v3 user positions on a specific market
async function getAavePositions(wallet, chainId, marketAddress) {
    const SUPPLY_Q = `
    query Q($user: String!, $markets: [MarketInput!]!) {
        userSupplies(request: { user: $user, markets: $markets, collateralsOnly: false, orderBy: { balance: DESC } }) {
            currency { symbol address decimals }
            balance { amount { value } usd }
            apy { formatted }
            isCollateral
        }
    }`;

    const BORROW_Q = `
    query Q($user: String!, $markets: [MarketInput!]!) {
        userBorrows(request: { user: $user, markets: $markets, orderBy: { debt: DESC } }) {
            currency { symbol address decimals }
            debt { amount { value } usd }
            apy { formatted }
        }
    }`;

    const HF_Q = `
    query Q($user: String!, $chainId: ChainId!, $market: String!) {
        userMarketState(request: { user: $user, chainId: $chainId, market: $market }) {
            healthFactor
            totalCollateralBase
            totalDebtBase
        }
    }`;

    const markets = [{ address: marketAddress, chainId }];

    const [supplies, borrows, state] = await Promise.all([
        gql(AAVE_GRAPHQL, SUPPLY_Q, { user: wallet, markets }),
        gql(AAVE_GRAPHQL, BORROW_Q, { user: wallet, markets }),
        gql(AAVE_GRAPHQL, HF_Q, { user: wallet, chainId, market: marketAddress })
    ]);

    return {
        supplies: supplies?.userSupplies || [],
        borrows: borrows?.userBorrows || [],
        state: state?.userMarketState || null
    };
}

// Get Morpho user positions
async function getMorphoPositions(wallet, chainId) {
    const QUERY = `
    query Q($address: String!, $chainId: Int!) {
        userByAddress(address: $address, chainId: $chainId) {
            marketPositions {
                market {
                    uniqueKey
                    loanAsset { address symbol }
                    collateralAsset { address symbol }
                    state { borrowApy supplyApy }
                }
                supplyAssets
                borrowAssets
                supplyAssetsUsd
                borrowAssetsUsd
            }
            vaultPositions {
                vault { address name asset { address symbol } }
                assetsUsd
            }
        }
    }`;

    const data = await gql(MORPHO_GRAPHQL, QUERY, { address: wallet, chainId });
    return data?.userByAddress || { marketPositions: [], vaultPositions: [] };
}

// Get token APYs from Portals
async function getTokenAPYs(symbols, chain) {
    if (!PORTALS_KEY) return {};

    const apys = {};
    // Query each symbol from Portals
    for (const symbol of symbols) {
        try {
            const params = new URLSearchParams({
                network: chain,
                limit: '5'
            });
            params.set('search', symbol);

            const res = await fetch(`${PORTALS_API}?${params}`, {
                headers: { 'Authorization': `Bearer ${PORTALS_KEY}` }
            });
            const data = await res.json();
            const tokens = data?.data || [];

            // Find exact match
            const match = tokens.find(t =>
                t.symbol?.toUpperCase() === symbol.toUpperCase() ||
                t.address?.toLowerCase() === symbol.toLowerCase()
            );
            if (match) {
                apys[symbol] = {
                    apy: match.metrics?.apy || 0,
                    tvl: match.metrics?.tvlUsd || 0,
                    price: match.price || 0
                };
            }
        } catch (e) {
            // skip
        }
    }
    return apys;
}

// Classify strategy
function classifyStrategy(supplies, borrows) {
    if (!supplies.length || !borrows.length) return 'lend';

    const totalSupply = supplies.reduce((s, x) => s + parseFloat(x.balance?.usd || 0), 0);
    const totalBorrow = borrows.reduce((s, x) => s + parseFloat(x.debt?.usd || 0), 0);

    if (totalSupply === 0) return 'unknown';

    const utilization = totalBorrow / totalSupply;
    if (utilization > 0.7) return 'loop';
    if (utilization > 0) return 'borrow';
    return 'lend';
}

// Detect yield source
function detectYieldSource(supplies) {
    const sources = new Set();
    for (const s of supplies) {
        const sym = (s.currency?.symbol || '').toUpperCase();
        if (sym.includes('USDE') || sym.includes('SUSDE')) sources.add('ethena');
        if (sym.includes('SYRUP') || sym.includes('MAPLE')) sources.add('maple');
        if (sym.includes('PT-') || sym.includes('PENDLE')) sources.add('pendle');
        if (sym.includes('SDAI') || sym.includes('DAI')) sources.add('maker');
        if (sym.includes('STETH') || sym.includes('WSTETH')) sources.add('lido');
        if (sym.includes('RETH')) sources.add('rocket-pool');
    }
    return [...sources].join(', ') || 'unknown';
}

// Initialize database
function initDB(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS wallets (
            id INTEGER PRIMARY KEY,
            address TEXT UNIQUE NOT NULL,
            label TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY,
            wallet_id INTEGER REFERENCES wallets(id),
            protocol TEXT NOT NULL,
            chain TEXT NOT NULL,
            chain_id INTEGER NOT NULL,
            market_address TEXT,
            collateral_token TEXT,
            collateral_amount REAL,
            collateral_usd REAL,
            collateral_apy REAL,
            collateral_source_apy REAL,
            borrow_token TEXT,
            borrow_amount REAL,
            borrow_usd REAL,
            borrow_apy REAL,
            health_factor REAL,
            utilization REAL,
            strategy TEXT,
            yield_source TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY,
            position_id INTEGER REFERENCES positions(id),
            timestamp TEXT DEFAULT (datetime('now')),
            collateral_usd REAL,
            borrow_usd REAL,
            health_factor REAL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique
            ON positions(wallet_id, protocol, chain, collateral_token, borrow_token);
    `);
    return db;
}

// Save Aave positions
function saveAavePositions(db, walletId, positions, chain, chainId, marketAddr) {
    const stmt = db.prepare(`
        INSERT INTO positions (wallet_id, protocol, chain, chain_id, market_address,
            collateral_token, collateral_amount, collateral_usd, collateral_apy,
            borrow_token, borrow_amount, borrow_usd, borrow_apy,
            health_factor, utilization, strategy, yield_source)
        VALUES (?, 'aave-v3', ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?)
        ON CONFLICT(wallet_id, protocol, chain, collateral_token, borrow_token)
        DO UPDATE SET
            collateral_amount=excluded.collateral_amount,
            collateral_usd=excluded.collateral_usd,
            collateral_apy=excluded.collateral_apy,
            borrow_amount=excluded.borrow_amount,
            borrow_usd=excluded.borrow_usd,
            borrow_apy=excluded.borrow_apy,
            health_factor=excluded.health_factor,
            utilization=excluded.utilization,
            strategy=excluded.strategy,
            yield_source=excluded.yield_source,
            updated_at=datetime('now')
    `);

    const { supplies, borrows, state } = positions;
    const strategy = classifyStrategy(supplies, borrows);
    const yieldSource = detectYieldSource(supplies);
    const totalSupply = supplies.reduce((s, x) => s + parseFloat(x.balance?.usd || 0), 0);
    const totalBorrow = borrows.reduce((s, x) => s + parseFloat(x.debt?.usd || 0), 0);
    const utilization = totalSupply > 0 ? totalBorrow / totalSupply : 0;
    const healthFactor = state ? parseFloat(state.healthFactor || 0) : 0;

    // Save each supply→borrow combination
    for (const supply of supplies) {
        const supUsd = parseFloat(supply.balance?.usd || 0);
        if (supUsd === 0) continue;

        for (const borrow of borrows) {
            const borUsd = parseFloat(borrow.debt?.usd || 0);
            if (borUsd === 0) continue;

            stmt.run(
                walletId, chain, chainId, marketAddr,
                supply.currency?.symbol, parseFloat(supply.balance?.amount?.value || 0), supUsd, parseFloat(supply.apy?.formatted || 0),
                borrow.currency?.symbol, parseFloat(borrow.debt?.amount?.value || 0), borUsd, parseFloat(borrow.apy?.formatted || 0),
                healthFactor, utilization, strategy, yieldSource
            );
        }

        // Also save supply-only position if no borrows
        if (borrows.length === 0) {
            stmt.run(
                walletId, chain, chainId, marketAddr,
                supply.currency?.symbol, parseFloat(supply.balance?.amount?.value || 0), supUsd, parseFloat(supply.apy?.formatted || 0),
                null, 0, 0, 0,
                healthFactor, 0, 'lend', yieldSource
            );
        }
    }
}

// Save Morpho positions
function saveMorphoPositions(db, walletId, morphoData, chain, chainId) {
    const stmt = db.prepare(`
        INSERT INTO positions (wallet_id, protocol, chain, chain_id, market_address,
            collateral_token, collateral_amount, collateral_usd, collateral_apy,
            borrow_token, borrow_amount, borrow_usd, borrow_apy,
            health_factor, utilization, strategy, yield_source)
        VALUES (?, 'morpho', ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?)
        ON CONFLICT(wallet_id, protocol, chain, collateral_token, borrow_token)
        DO UPDATE SET
            collateral_amount=excluded.collateral_amount,
            collateral_usd=excluded.collateral_usd,
            collateral_apy=excluded.collateral_apy,
            borrow_amount=excluded.borrow_amount,
            borrow_usd=excluded.borrow_usd,
            borrow_apy=excluded.borrow_apy,
            health_factor=excluded.health_factor,
            utilization=excluded.utilization,
            strategy=excluded.strategy,
            yield_source=excluded.yield_source,
            updated_at=datetime('now')
    `);

    for (const pos of morphoData.marketPositions || []) {
        const market = pos.market;
        const supplyUsd = parseFloat(pos.supplyAssetsUsd || 0);
        const borrowUsd = parseFloat(pos.borrowAssetsUsd || 0);
        const supplyApy = (market.state?.supplyApy || 0) * 100;
        const borrowApy = (market.state?.borrowApy || 0) * 100;
        const utilization = supplyUsd > 0 ? borrowUsd / supplyUsd : 0;
        const collateralSym = market.collateralAsset?.symbol;
        const loanSym = market.loanAsset?.symbol;
        const strategy = utilization > 0.7 ? 'loop' : utilization > 0 ? 'borrow' : 'lend';
        const yieldSource = detectYieldSource([{ currency: { symbol: collateralSym } }]);

        stmt.run(
            walletId, chain, chainId, market.uniqueKey,
            collateralSym, parseFloat(pos.supplyAssets || 0), supplyUsd, supplyApy,
            loanSym, parseFloat(pos.borrowAssets || 0), borrowUsd, borrowApy,
            0, utilization, strategy, yieldSource
        );
    }

    // Vault positions
    for (const v of morphoData.vaultPositions || []) {
        const usd = parseFloat(v.assetsUsd || 0);
        if (usd === 0) continue;
        stmt.run(
            walletId, chain, chainId, null,
            v.vault?.asset?.symbol, 0, usd, 0,
            null, 0, 0, 0,
            0, 0, 'vault', detectYieldSource([{ currency: { symbol: v.vault?.asset?.symbol } }])
        );
    }
}

// Main
async function main() {
    console.log('=== Protocol Yield Tracker ===\n');

    const wallets = loadWallets();
    console.log(`Loaded ${wallets.length} wallets\n`);

    const db = initDB(path.join(__dirname, '..', 'yield-tracker.db'));

    // Insert wallets
    const insertWallet = db.prepare('INSERT OR IGNORE INTO wallets (address, label) VALUES (?, ?)');
    for (const w of wallets) {
        insertWallet.run(w.address, w.label || null);
    }

    // Get wallet IDs
    const getWalletId = db.prepare('SELECT id FROM wallets WHERE address = ?');

    // Define chains to check (only chains where wallets have positions)
    const AAVE_CHAINS = [
        { id: 1, name: 'ethereum' },
        { id: 8453, name: 'base' },
        { id: 9745, name: 'plasma' },
        { id: 5000, name: 'mantle' },
    ];

    const MORPHO_CHAINS = [
        { id: 1, name: 'ethereum' },
        { id: 42161, name: 'arbitrum' },
    ];

    // Discover Aave markets dynamically
    console.log('Discovering Aave v3 markets...');
    const chainIds = AAVE_CHAINS.map(c => c.id);
    const markets = await getAaveMarkets(chainIds);
    console.log(`  Found ${markets.length} markets\n`);

    const marketMap = {};
    for (const m of markets) {
        const cid = m.chain.chainId;
        if (!marketMap[cid]) marketMap[cid] = [];
        marketMap[cid].push(m);
    }

    // Process each wallet
    let totalPositions = 0;
    for (const wallet of wallets) {
        const short = wallet.address.slice(0, 10) + '...' + wallet.address.slice(-4);
        const walletRow = getWalletId.get(wallet.address);
        if (!walletRow) continue;
        const walletId = walletRow.id;

        console.log(`\n${short} ${wallet.label ? '(' + wallet.label + ')' : ''}`);

        // Aave v3
        for (const chain of AAVE_CHAINS) {
            const chainMarkets = marketMap[chain.id] || [];
            if (chainMarkets.length === 0) continue;
            console.log(`  Aave ${chain.name}: ${chainMarkets.map(m => m.name).join(', ')}`);
            for (const market of chainMarkets) {
                try {
                    const positions = await getAavePositions(wallet.address, chain.id, market.address);
                    const supUsd = positions.supplies.map(s => parseFloat(s.balance?.usd || 0)).filter(v => v > 0);
                    const borUsd = positions.borrows.map(b => parseFloat(b.debt?.usd || 0)).filter(v => v > 0);
                    if (supUsd.length > 0 || borUsd.length > 0) {
                        saveAavePositions(db, walletId, positions, chain.name, chain.id, market.address);
                        console.log(`  Aave ${chain.name} (${market.name}): $${(supUsd.reduce((a,b)=>a+b,0) / 1e6).toFixed(1)}M collateral / $${(borUsd.reduce((a,b)=>a+b,0) / 1e6).toFixed(1)}M debt`);
                        totalPositions++;
                    } else {
                        console.log(`  [empty] ${market.name} sup=${supUsd.length} bor=${borUsd.length}`);
                    }
                } catch (e) {
                    // skip chain errors
                }
                await new Promise(r => setTimeout(r, 200));
            }
        }

        // Morpho
        for (const chain of MORPHO_CHAINS) {
            try {
                const morphoData = await getMorphoPositions(wallet.address, chain.id);
                const hasMarkets = (morphoData.marketPositions || []).some(p =>
                    parseFloat(p.supplyAssetsUsd || 0) > 0 || parseFloat(p.borrowAssetsUsd || 0) > 0
                );
                const hasVaults = (morphoData.vaultPositions || []).some(v => parseFloat(v.assetsUsd || 0) > 0);

                if (hasMarkets || hasVaults) {
                    saveMorphoPositions(db, walletId, morphoData, chain.name, chain.id);
                    for (const p of morphoData.marketPositions || []) {
                        if (parseFloat(p.supplyAssetsUsd || 0) > 0 || parseFloat(p.borrowAssetsUsd || 0) > 0) {
                            console.log(`  Morpho ${chain.name}: ${p.market.collateralAsset?.symbol} → ${p.market.loanAsset?.symbol}`);
                        }
                    }
                    totalPositions++;
                }
            } catch (e) {
                // skip
            }
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // Summary
    const stats = db.prepare(`
        SELECT protocol, chain, COUNT(*) as count,
               SUM(collateral_usd) as total_collateral,
               SUM(borrow_usd) as total_debt
        FROM positions
        GROUP BY protocol, chain
        ORDER BY total_collateral DESC
    `).all();

    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(60)}`);
    for (const s of stats) {
        console.log(`  ${s.protocol.padEnd(10)} ${s.chain.padEnd(12)} ${s.count} positions  $${(s.total_collateral / 1e6).toFixed(0)}M collateral / $${(s.total_debt / 1e6).toFixed(0)}M debt`);
    }

    db.close();
    console.log('\nDone. Database saved to yield-tracker.db');
}

main().catch(console.error);
