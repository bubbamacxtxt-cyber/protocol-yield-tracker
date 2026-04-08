#!/usr/bin/env node
/**
 * Protocol Yield Tracker — Data Export (Multi-Whale)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const OUT_PATH = path.join(__dirname, '..', 'data.json');

// Whale definitions loaded from data/whales.json
const WHALES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));

function main() {
    const db = new Database(DB_PATH, { readonly: true });

    // Load manual positions (RWAs, off-chain, etc.)
    const manualPath = path.join(__dirname, '..', 'data', 'manual-positions.json');
    let manualPositions = {};
    if (fs.existsSync(manualPath)) {
        manualPositions = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
    }

    // Load all positions with token data
    const allPositions = db.prepare(`
        SELECT p.*,
            (SELECT json_group_array(json_object(
                'symbol', pt.symbol, 'real_symbol', pt.real_symbol, 'real_name', pt.real_name,
                'address', pt.address, 'amount', pt.amount, 'price_usd', pt.price_usd, 'value_usd', pt.value_usd
            )) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'supply') as supply_json,
            (SELECT json_group_array(json_object(
                'symbol', pt.symbol, 'real_symbol', pt.real_symbol, 'real_name', pt.real_name,
                'address', pt.address, 'amount', pt.amount, 'price_usd', pt.price_usd, 'value_usd', pt.value_usd
            )) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'borrow') as borrow_json,
            (SELECT json_group_array(json_object(
                'symbol', pt.symbol, 'real_symbol', pt.real_symbol,
                'amount', pt.amount, 'value_usd', pt.value_usd
            )) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'reward') as reward_json
        FROM positions p
        ORDER BY p.net_usd DESC
    `).all();

    for (const p of allPositions) {
        p.supply = JSON.parse(p.supply_json || '[]');
        p.borrow = JSON.parse(p.borrow_json || '[]');
        p.rewards = JSON.parse(p.reward_json || '[]');
        delete p.supply_json;
        delete p.borrow_json;
        delete p.reward_json;
    }

    // Remove near-duplicates: old scan entries superseded by newer ones with overlapping supply tokens
    const deduped = [];
    const seen = new Map(); // key: wallet|chain|protocol|supplyTokens -> latest position
    for (const p of allPositions) {
        const supplyAddrs = (p.supply || []).map(t => t.address).filter(Boolean).sort().join(',') || 'none';
        const key = p.wallet + '|' + p.chain + '|' + p.protocol_id + '|' + supplyAddrs;
        if (!seen.has(key)) {
            seen.set(key, p);
            deduped.push(p);
        }
        // If seen before, keep the one with higher net_usd (likely the more complete scan)
        else if (p.net_usd > seen.get(key).net_usd) {
            const idx = deduped.indexOf(seen.get(key));
            deduped[idx] = p;
            seen.set(key, p);
        }
    }

    // Build whale data
    const whales = {};
    for (const [name, definition] of Object.entries(WHALES)) {
        // Handle both formats: simple wallet list or multi-vault
        let walletList, vaults = null;
        if (Array.isArray(definition)) {
            walletList = definition;
        } else if (definition.vaults) {
            vaults = definition.vaults;
            walletList = Object.values(vaults).flat();
        } else {
            continue;
        }

        const walletSet = new Set(walletList.map(w => w.toLowerCase()));
        const positions = deduped.filter(p => walletSet.has(p.wallet.toLowerCase()));

        // Merge manual positions if they exist for this whale
        if (manualPositions[name]) {
            positions.push(...manualPositions[name]);
        }

        // If multi-vault, build vault breakdown
        let vaultData = null;
        if (vaults) {
            vaultData = {};
            for (const [vaultName, vaultWallets] of Object.entries(vaults)) {
                const vWalletSet = new Set(vaultWallets.map(w => w.toLowerCase()));
                const vPositions = positions.filter(p => vWalletSet.has(p.wallet.toLowerCase()));
                vaultData[vaultName] = {
                    name: vaultName,
                    wallets: vaultWallets,
                    total_wallets: vaultWallets.length,
                    active_wallets: [...new Set(vPositions.map(p => p.wallet))].length,
                    positions: vPositions,
                    slug: vaultName.toLowerCase().replace(/[^a-z0-9]/g, '-')
                };
            }
        }

        whales[name] = {
            name,
            wallets: walletList,
            total_wallets: walletList.length,
            active_wallets: [...new Set(positions.map(p => p.wallet))].length,
            positions,
            is_multi_vault: !!vaults,
            vaults: vaultData
        };
    }

    // Add manual-only whales (no on-chain wallets, entirely manual positions)
    for (const [name, positions] of Object.entries(manualPositions)) {
        if (!whales[name] && positions.length > 0) {
            const uniqueWallets = [...new Set(positions.map(p => p.wallet))];
            whales[name] = {
                name,
                wallets: uniqueWallets,
                total_wallets: uniqueWallets.length,
                active_wallets: uniqueWallets.length,
                positions,
                is_multi_vault: false,
                vaults: null
            };
        }
    }

    // Global summary
    let totalPositions = 0, totalValue = 0, totalAssets = 0, totalDebt = 0, totalWallets = 0, totalActive = 0;
    const allChains = new Set(), allProtos = new Set();

    for (const w of Object.values(whales)) {
        totalPositions += w.positions.length;
        totalWallets += w.total_wallets;
        totalActive += w.active_wallets;
        for (const p of w.positions) {
            totalValue += p.net_usd;
            totalAssets += p.asset_usd;
            totalDebt += p.debt_usd;
            allChains.add(p.chain);
            allProtos.add(p.protocol_name);
        }
    }

    const data = {
        generated_at: new Date().toISOString(),
        summary: {
            total_positions: totalPositions,
            total_value: totalValue,
            total_assets: totalAssets,
            total_debt: totalDebt,
            total_whales: Object.keys(whales).length,
            total_wallets: totalWallets,
            total_active: totalActive,
            chains: [...allChains],
            protocols: [...allProtos]
        },
        whales
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
    console.log(`Exported ${totalPositions} positions across ${Object.keys(whales).length} whales`);

    for (const [name, w] of Object.entries(whales)) {
        console.log(`  ${name}: ${w.positions.length} positions, ${w.active_wallets}/${w.total_wallets} wallets active`);
    }

    db.close();
}

main();
