#!/usr/bin/env node
/**
 * Protocol Yield Tracker — DeBank Cloud Fetcher
 * Scans wallets across 1000+ protocols using DeBank API
 */

const fs = require('fs');
const path = require('path');

const DEBANK_API = 'https://pro-openapi.debank.com';
const DEBANK_KEY = process.env.DEBANK_API_KEY;
const MIN_NET_USD = 50000; // ignore positions under $50K

// Load wallet list
function loadWallets() {
    const file = path.join(__dirname, '..', 'data', 'wallets.json');
    if (!fs.existsSync(file)) {
        console.error('Missing data/wallets.json');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// DeBank API call
async function api(endpoint) {
    const res = await fetch(`${DEBANK_API}${endpoint}`, {
        headers: {
            'Accept': 'application/json',
            'AccessKey': DEBANK_KEY
        }
    });
    if (!res.ok) throw new Error(`DeBank ${res.status}: ${await res.text()}`);
    return res.json();
}

// Phase 1: Discover which chains each wallet is active on
async function discoverChains(wallets) {
    console.log('Phase 1: Discovering chains...\n');
    const walletChains = {};

    for (const w of wallets) {
        const addr = w.address;
        const short = addr.slice(0, 10) + '...' + addr.slice(-4);
        try {
            const chains = await api(`/v1/user/used_chain_list?id=${addr}`);
            walletChains[addr] = chains.map(c => c.id);
            console.log(`  ${short}: ${chains.length} chains`);
        } catch (e) {
            console.error(`  ${short}: ERROR ${e.message}`);
            walletChains[addr] = [];
        }
        await new Promise(r => setTimeout(r, 100));
    }

    return walletChains;
}

// Phase 2: Get all positions per wallet per chain
async function scanPositions(walletChains) {
    console.log('\nPhase 2: Scanning positions...\n');
    const positions = [];
    let calls = 0;

    for (const [addr, chains] of Object.entries(walletChains)) {
        const short = addr.slice(0, 10) + '...' + addr.slice(-4);
        let walletPositions = 0;

        for (const chain of chains) {
            try {
                const data = await api(`/v1/user/complex_protocol_list?id=${addr}&chain_id=${chain}`);
                calls++;

                if (!Array.isArray(data)) continue;

                for (const protocol of data) {
                    for (const item of protocol.portfolio_item_list || []) {
                        const stats = item.stats || {};
                        const netUsd = stats.net_usd_value || 0;

                        if (netUsd < MIN_NET_USD) continue;

                        const detail = item.detail || {};
                        const supplyTokens = (detail.supply_token_list || []).map(t => ({
                            symbol: t.symbol || '?',
                            amount: t.amount || 0,
                            usd: t.amount * (t.price || 0)
                        }));
                        const borrowTokens = (detail.borrow_token_list || []).map(t => ({
                            symbol: t.symbol || '?',
                            amount: t.amount || 0,
                            usd: t.amount * (t.price || 0)
                        }));
                        const rewardTokens = (detail.reward_token_list || []).map(t => ({
                            symbol: t.symbol || '?',
                            amount: t.amount || 0
                        }));

                        // Classify strategy
                        let strategy = 'unknown';
                        const posType = item.name || '';
                        if (posType === 'Lending' && borrowTokens.length > 0) {
                            const supplyUsd = supplyTokens.reduce((s, t) => s + t.usd, 0);
                            const borrowUsd = borrowTokens.reduce((s, t) => s + t.usd, 0);
                            strategy = supplyUsd > 0 && borrowUsd / supplyUsd > 0.7 ? 'loop' : 'borrow';
                        } else if (posType === 'Lending') {
                            strategy = 'lend';
                        } else if (posType === 'Farming' || posType === 'Leveraged Farming') {
                            strategy = 'farm';
                        } else if (posType === 'Staked' || posType === 'Locked') {
                            strategy = 'stake';
                        } else if (posType === 'Liquidity Pool') {
                            strategy = 'lp';
                        }

                        // Detect yield sources
                        const sources = new Set();
                        for (const t of [...supplyTokens, ...rewardTokens]) {
                            const sym = (t.symbol || '').toUpperCase();
                            if (sym.includes('USDE') || sym.includes('SUSDE')) sources.add('ethena');
                            if (sym.includes('SYRUP') || sym.includes('MAPLE')) sources.add('maple');
                            if (sym.includes('PT-') || sym.includes('PENDLE')) sources.add('pendle');
                            if (sym.includes('STETH') || sym.includes('WSTETH')) sources.add('lido');
                        }

                        positions.push({
                            wallet: addr,
                            label: '',
                            chain,
                            protocol: protocol.name || '?',
                            protocol_id: protocol.id || '?',
                            type: posType,
                            strategy,
                            yield_source: [...sources].join(', ') || 'unknown',
                            net_usd: Math.round(netUsd * 100) / 100,
                            asset_usd: Math.round((stats.asset_usd_value || 0) * 100) / 100,
                            debt_usd: Math.round((stats.debt_usd_value || 0) * 100) / 100,
                            supply: supplyTokens,
                            borrow: borrowTokens,
                            rewards: rewardTokens,
                            scanned_at: new Date().toISOString()
                        });
                        walletPositions++;
                    }
                }

                await new Promise(r => setTimeout(r, 100));
            } catch (e) {
                calls++;
            }
        }

        if (walletPositions > 0) {
            console.log(`  ${short}: ${walletPositions} positions`);
        }
    }

    return { positions, calls };
}

// Print summary
function printSummary(positions) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`FOUND ${positions.length} positions >$${(MIN_NET_USD/1000).toFixed(0)}K`);
    console.log(`${'='.repeat(60)}\n`);

    // By protocol
    const byProto = {};
    for (const p of positions) {
        if (!byProto[p.protocol]) byProto[p.protocol] = { count: 0, total: 0 };
        byProto[p.protocol].count++;
        byProto[p.protocol].total += p.net_usd;
    }
    console.log('BY PROTOCOL:');
    for (const [proto, info] of Object.entries(byProto).sort((a, b) => b[1].total - a[1].total)) {
        console.log(`  ${proto.padEnd(25)} ${info.count.toString().padStart(3)} positions  $${(info.total / 1e6).toFixed(1)}M`);
    }

    // By chain
    const byChain = {};
    for (const p of positions) {
        if (!byChain[p.chain]) byChain[p.chain] = { count: 0, total: 0 };
        byChain[p.chain].count++;
        byChain[p.chain].total += p.net_usd;
    }
    console.log('\nBY CHAIN:');
    for (const [chain, info] of Object.entries(byChain).sort((a, b) => b[1].total - a[1].total)) {
        console.log(`  ${chain.padEnd(12)} ${info.count.toString().padStart(3)} positions  $${(info.total / 1e6).toFixed(1)}M`);
    }

    // By wallet
    const byWallet = {};
    for (const p of positions) {
        const k = p.wallet;
        if (!byWallet[k]) byWallet[k] = { count: 0, total: 0, protocols: new Set() };
        byWallet[k].count++;
        byWallet[k].total += p.net_usd;
        byWallet[k].protocols.add(p.protocol);
    }
    console.log('\nBY WALLET:');
    for (const [wallet, info] of Object.entries(byWallet).sort((a, b) => b[1].total - a[1].total)) {
        const short = wallet.slice(0, 10) + '...' + wallet.slice(-4);
        console.log(`  ${short} ${info.count.toString().padStart(2)} positions  $${(info.total / 1e6).toFixed(1)}M  [${[...info.protocols].join(', ')}]`);
    }

    // Top 10
    console.log(`\n${'='.repeat(60)}`);
    console.log('TOP 10 POSITIONS');
    console.log(`${'='.repeat(60)}`);
    for (const p of positions.sort((a, b) => b.net_usd - a.net_usd).slice(0, 10)) {
        const w = p.wallet.slice(0, 6) + '...' + p.wallet.slice(-4);
        const supply = p.supply.map(t => t.symbol).join('+') || '-';
        const borrow = p.borrow.map(t => t.symbol).join('+') || '-';
        console.log(`  ${w} | ${p.protocol.padEnd(15)} | ${p.chain.padEnd(10)} | ${p.type.padEnd(15)} | $${(p.net_usd / 1e6).toFixed(1)}M | ${supply} → ${borrow}`);
    }
}

// Main
async function main() {
    if (!DEBANK_KEY) {
        console.error('Missing DEBANK_API_KEY env var');
        process.exit(1);
    }

    console.log('=== Protocol Yield Tracker (DeBank) ===\n');

    // Check units
    const unitsBefore = await api('/v1/account/units');
    console.log(`Units: ${unitsBefore.balance.toLocaleString()} available\n`);

    const wallets = loadWallets();
    console.log(`Loaded ${wallets.length} wallets\n`);

    // Phase 1: Discover chains
    const walletChains = await discoverChains(wallets);

    // Phase 2: Scan positions
    const { positions, calls } = await scanPositions(walletChains);

    // Save results
    const output = { positions, api_calls: calls, scanned_at: new Date().toISOString() };
    const outPath = path.join(__dirname, '..', 'data', 'debank-scan.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

    // Summary
    printSummary(positions);

    // Units used
    const unitsAfter = await api('/v1/account/units');
    const used = unitsBefore.balance - unitsAfter.balance;
    console.log(`\nUnits used: ${used} (remaining: ${unitsAfter.balance.toLocaleString()})`);
    console.log(`Cost: $${(used / 1000000 * 200).toFixed(2)}`);
    console.log(`\nDone. Results saved to data/debank-scan.json`);
}

main().catch(console.error);
