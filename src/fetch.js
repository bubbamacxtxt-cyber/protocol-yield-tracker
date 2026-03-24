#!/usr/bin/env node
/**
 * Protocol Yield Tracker — DeBank Cloud Fetcher v2
 * Full position data: amounts, prices, health rate, strategy classification
 */

const fs = require('fs');
const path = require('path');

const DEBANK_API = 'https://pro-openapi.debank.com';
const DEBANK_KEY = process.env.DEBANK_API_KEY;
const MIN_NET_USD = 50000;

function loadWallets() {
    const file = path.join(__dirname, '..', 'data', 'wallets.json');
    if (!fs.existsSync(file)) { console.error('Missing data/wallets.json'); process.exit(1); }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function api(endpoint) {
    const res = await fetch(`${DEBANK_API}${endpoint}`, {
        headers: { 'Accept': 'application/json', 'AccessKey': DEBANK_KEY }
    });
    if (!res.ok) throw new Error(`DeBank ${res.status}: ${await res.text()}`);
    return res.json();
}

function classifyStrategy(item, supplyUsd, borrowUsd) {
    const type = item.name || '';
    if (type === 'Lending') {
        if (supplyUsd > 0 && borrowUsd > 0) {
            const util = borrowUsd / supplyUsd;
            return util > 0.7 ? 'loop' : 'borrow';
        }
        return 'lend';
    }
    if (type === 'Farming' || type === 'Leveraged Farming') return 'farm';
    if (type === 'Staked' || type === 'Locked') return 'stake';
    if (type === 'Liquidity Pool') return 'lp';
    if (type === 'Yield' || type === 'Deposit') return 'yield';
    if (type === 'Vesting') return 'vesting';
    return type.toLowerCase().replace(/ /g, '_') || 'unknown';
}

function detectYieldSource(tokens) {
    const sources = new Set();
    for (const t of tokens) {
        const sym = (t.symbol || '').toUpperCase();
        if (sym.includes('USDE') || sym.includes('SUSDE')) sources.add('ethena');
        if (sym.includes('SYRUP') || sym.includes('MAPLE')) sources.add('maple');
        if (sym.includes('PT-') || sym.includes('PENDLE')) sources.add('pendle');
        if (sym.includes('STETH') || sym.includes('WSTETH')) sources.add('lido');
        if (sym.includes('RETH')) sources.add('rocket-pool');
        if (sym.includes('GHO')) sources.add('aave');
    }
    return [...sources].join(', ') || 'unknown';
}

async function scanAll() {
    if (!DEBANK_KEY) { console.error('Missing DEBANK_API_KEY'); process.exit(1); }

    console.log('=== Protocol Yield Tracker (DeBank v2) ===\n');

    const unitsBefore = await api('/v1/account/units');
    console.log(`Units: ${unitsBefore.balance.toLocaleString()} available\n`);

    const wallets = loadWallets();
    console.log(`Loaded ${wallets.length} wallets\n`);

    // Phase 1: Discover chains
    console.log('Phase 1: Discovering chains...\n');
    const walletChains = {};
    for (const w of wallets) {
        const short = w.address.slice(0, 10) + '...' + w.address.slice(-4);
        try {
            const chains = await api(`/v1/user/used_chain_list?id=${w.address}`);
            walletChains[w.address] = chains.map(c => c.id);
            console.log(`  ${short}: ${chains.length} chains`);
        } catch (e) {
            console.error(`  ${short}: ERROR`);
            walletChains[w.address] = [];
        }
        await new Promise(r => setTimeout(r, 100));
    }

    // Phase 2: Scan positions
    console.log('\nPhase 2: Scanning positions...\n');
    const positions = [];
    let calls = 0;

    for (const [addr, chains] of Object.entries(walletChains)) {
        const short = addr.slice(0, 10) + '...' + addr.slice(-4);
        let count = 0;

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
                        const assetTokens = item.asset_token_list || [];
                        const healthRate = detail.health_rate || null;

                        // Build supply/borrow from asset_token_list (has amounts + prices)
                        const supplyTokens = [];
                        const borrowTokens = [];
                        for (const t of assetTokens) {
                            const token = {
                                symbol: t.symbol || '?',
                                address: t.id || '',
                                amount: Math.abs(t.amount || 0),
                                price: t.price || 0,
                                usd: Math.abs(t.amount || 0) * (t.price || 0)
                            };
                            if ((t.amount || 0) > 0) supplyTokens.push(token);
                            else borrowTokens.push(token);
                        }

                        const supplyUsd = supplyTokens.reduce((s, t) => s + t.usd, 0);
                        const borrowUsd = borrowTokens.reduce((s, t) => s + t.usd, 0);

                        // Reward tokens
                        const rewardTokens = [];
                        for (const rt of (detail.reward_token_list || [])) {
                            rewardTokens.push({
                                symbol: rt.symbol || '?',
                                amount: rt.amount || 0,
                                usd: rt.amount * (rt.price || 0)
                            });
                        }

                        const strategy = classifyStrategy(item, supplyUsd, borrowUsd);
                        const yieldSource = detectYieldSource([...supplyTokens, ...rewardTokens]);

                        positions.push({
                            wallet: addr,
                            chain,
                            protocol: protocol.name || '?',
                            protocol_id: protocol.id || '?',
                            type: item.name || '?',
                            strategy,
                            yield_source: yieldSource,
                            health_rate: healthRate ? Math.round(healthRate * 1000) / 1000 : null,
                            net_usd: Math.round(netUsd * 100) / 100,
                            asset_usd: Math.round(supplyUsd * 100) / 100,
                            debt_usd: Math.round(borrowUsd * 100) / 100,
                            supply: supplyTokens,
                            borrow: borrowTokens,
                            rewards: rewardTokens,
                            position_index: item.position_index || null,
                            updated_at: item.update_at ? new Date(item.update_at * 1000).toISOString() : null
                        });
                        count++;
                    }
                }
                await new Promise(r => setTimeout(r, 100));
            } catch (e) {
                calls++;
            }
        }

        if (count > 0) console.log(`  ${short}: ${count} positions`);
    }

    // Save
    const output = { positions, api_calls: calls, scanned_at: new Date().toISOString() };
    const outPath = path.join(__dirname, '..', 'data', 'debank-scan.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

    // Summary
    printSummary(positions);

    const unitsAfter = await api('/v1/account/units');
    const used = unitsBefore.balance - unitsAfter.balance;
    console.log(`\nUnits used: ${used} (remaining: ${unitsAfter.balance.toLocaleString()})`);
    console.log(`Cost: $${(used / 1000000 * 200).toFixed(2)}`);
    console.log(`\nDone. Saved to data/debank-scan.json`);
}

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

    // Top positions
    console.log(`\n${'='.repeat(60)}`);
    console.log('ALL POSITIONS');
    console.log(`${'='.repeat(60)}`);
    for (const p of positions.sort((a, b) => b.net_usd - a.net_usd)) {
        const w = p.wallet.slice(0, 6) + '...' + p.wallet.slice(-4);
        const sup = p.supply.map(t => `${t.symbol}(${t.amount.toLocaleString(undefined,{maximumFractionDigits:0})}=$${(t.usd/1e6).toFixed(1)}M)`).join('+') || '-';
        const bor = p.borrow.map(t => `${t.symbol}(${t.amount.toLocaleString(undefined,{maximumFractionDigits:0})}=$${(t.usd/1e6).toFixed(1)}M)`).join('+') || '-';
        const hf = p.health_rate ? ` HF:${p.health_rate}` : '';
        console.log(`  ${w} | ${p.protocol.padEnd(15)} | ${p.chain.padEnd(8)} | ${p.type.padEnd(10)} ${p.strategy.padEnd(8)} | ${sup} → ${bor}${hf}`);
    }
}

scanAll().catch(console.error);
