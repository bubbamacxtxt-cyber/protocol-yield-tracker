const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'yield-tracker.db'));
const API = 'https://pro-openapi.debank.com';
const KEY = process.env.DEBANK_API_KEY;

async function api(p) {
    const r = await fetch(API + p, { headers: { 'Accept': 'application/json', 'AccessKey': KEY } });
    return r.json();
}

const MONEY_MARKETS = ['aave', 'morpho', 'euler', 'spark', 'compound', 'fluid', 'venus'];

function getDisplayType(item, protocolName) {
    const isMM = MONEY_MARKETS.some(mm => (protocolName || '').toLowerCase().includes(mm));
    return isMM ? 'Lending' : (item.name || '?');
}

function classifyStrategy(displayType, supplyUsd, borrowUsd, hf) {
    if (displayType === 'Lending') return (borrowUsd > 0 || hf) ? 'loop' : 'lend';
    if (displayType === 'Farming' || displayType === 'Leveraged Farming') return 'farm';
    if (displayType === 'Staked' || displayType === 'Locked') return 'stake';
    if (displayType === 'Liquidity Pool') return 'lp';
    if (displayType === 'Yield' || displayType === 'Deposit') return (borrowUsd > 0 || hf) ? 'loop' : 'lend';
    return 'unknown';
}

async function scanWallets(wallets, label) {
    console.log(`\n=== Scanning ${label} (${wallets.length} wallets) ===\n`);
    
    const posStmt = db.prepare(`
        INSERT OR REPLACE INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, yield_source, health_rate, net_usd, asset_usd, debt_usd, position_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tokStmt = db.prepare(`
        INSERT INTO position_tokens (position_id, role, symbol, real_symbol, real_name, address, amount, price_usd, value_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalPositions = 0;

    for (const addr of wallets) {
        const short = addr.slice(0, 8) + '...';

        // Clear old positions for this wallet before scanning
        db.prepare('DELETE FROM position_tokens WHERE position_id IN (SELECT id FROM positions WHERE wallet = ?)').run(addr);
        db.prepare('DELETE FROM positions WHERE wallet = ?').run(addr);

        const chains = await api(`/v1/user/used_chain_list?id=${addr}`);
        let walletPositions = 0;

        for (const c of chains) {
            const bal = await api(`/v1/user/chain_balance?id=${addr}&chain_id=${c.id}`);
            const chainBalance = bal.usd_value || 0;
            if (chainBalance < 50000) continue;

            const data = await api(`/v1/user/complex_protocol_list?id=${addr}&chain_id=${c.id}`);
            if (!Array.isArray(data)) continue;

            let chainPositionsUsd = 0;

            for (const proto of data) {
                for (const item of proto.portfolio_item_list || []) {
                    const stats = item.stats || {};
                    const net = stats.net_usd_value || 0;
                    if (net < 50000) continue;

                    chainPositionsUsd += net;

                    const detail = item.detail || {};
                    const assetTokens = item.asset_token_list || [];
                    const hf = detail.health_rate || null;
                    const assets = stats.asset_usd_value || 0;
                    const debt = stats.debt_usd_value || 0;

                    const supplyUsd = assetTokens.filter(t => (t.amount || 0) > 0).reduce((s, t) => s + Math.abs(t.amount || 0) * (t.price || 0), 0);
                    const borrowUsd = assetTokens.filter(t => (t.amount || 0) < 0).reduce((s, t) => s + Math.abs(t.amount || 0) * (t.price || 0), 0);

                    const displayType = getDisplayType(item, proto.name);
                    const strategy = classifyStrategy(displayType, supplyUsd, borrowUsd, hf);

                    // Generate unique position_index from token addresses
                    const tokenAddrs = assetTokens.map(t => t.id || '').sort().join(',');
                    const uniqueIndex = item.position_index || `${tokenAddrs}_${Math.round(net)}` || `pos_${Date.now()}`;

                    // Delete old tokens for this position (if replacing)
                    const existingPos = db.prepare('SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = ? AND position_index = ?').get(addr, c.id, proto.id || '?', uniqueIndex);
                    if (existingPos) {
                        db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(existingPos.id);
                    }

                    // Save position
                    const result = posStmt.run(
                        addr, c.id, proto.id || '?', proto.name || '?',
                        displayType, strategy, proto.name || '?',
                        hf ? Math.round(hf * 1000) / 1000 : null,
                        Math.round(net * 100) / 100,
                        Math.round(assets * 100) / 100,
                        Math.round(debt * 100) / 100,
                        uniqueIndex
                    );
                    const posId = result.lastInsertRowid;

                    // Save tokens
                    const saveTokens = db.transaction(() => {
                        for (const t of assetTokens) {
                            const amount = Math.abs(t.amount || 0);
                            const price = t.price || 0;
                            const role = (t.amount || 0) > 0 ? 'supply' : 'borrow';
                            tokStmt.run(posId, role, t.symbol || '?', t.symbol || '?', t.name || '', t.id || '', amount, price, amount * price);
                        }
                    });
                    saveTokens();

                    walletPositions++;
                }
            }

            // Balance verification: ALWAYS check token_list for chains >$50K
            const gap = chainBalance - chainPositionsUsd;
            if (gap > 50000) {
                if (chainPositionsUsd > 0 && (gap / chainBalance) > 0.05) {
                    console.log(`  ⚠️ ${c.id}: balance=$${chainBalance.toLocaleString()} positions=$${chainPositionsUsd.toLocaleString()} gap=$${gap.toLocaleString()}`);
                } else if (chainPositionsUsd === 0) {
                    console.log(`  ⚠️ ${c.id}: balance=$${chainBalance.toLocaleString()} no protocol positions`);
                }
                
                // Check token list for wallet-held AND protocol tokens not detected by complex_protocol_list
                try {
                    const tokens = await api(`/v1/user/token_list?id=${addr}&chain_id=${c.id}&is_all=false`);
                    if (Array.isArray(tokens)) {
                        // Track which protocol_ids we already have in DB
                        const existingProtocols = db.prepare('SELECT DISTINCT protocol_id FROM positions WHERE wallet = ? AND chain = ?').all(addr, c.id).map(r => r.protocol_id);
                        
                        for (const t of tokens) {
                            const usd = (t.amount || 0) * (t.price || 0);
                            if (usd < 50000) continue;
                            
                            const protoId = t.protocol_id || '';
                            
                            if (!protoId) {
                                // Wallet-held token (not in any protocol)
                                const existingWallet = db.prepare('SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = ? AND position_index = ?').get(addr, c.id, 'wallet-held', t.id || '');
                                if (existingWallet) {
                                    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(existingWallet.id);
                                }
                                const result = posStmt.run(addr, c.id, 'wallet-held', 'Wallet', 'Holding', 'hold', 'wallet', null, Math.round(usd * 100) / 100, Math.round(usd * 100) / 100, 0, t.id || '');
                                tokStmt.run(result.lastInsertRowid, 'supply', t.symbol || '?', t.symbol || '?', t.name || '', t.id || '', t.amount || 0, t.price || 0, usd);
                                walletPositions++;
                                console.log(`    + ${t.symbol}: $${usd.toLocaleString()} (wallet-held)`);
                            } else if (!existingProtocols.includes(protoId)) {
                                // Protocol token not detected by complex_protocol_list
                                const existingProto = db.prepare('SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = ? AND position_index = ?').get(addr, c.id, protoId, t.id || '');
                                if (existingProto) {
                                    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(existingProto.id);
                                }
                                const result = posStmt.run(addr, c.id, protoId, protoId.replace(/[_-]/g, ' '), 'Lending', 'lend', protoId, null, Math.round(usd * 100) / 100, Math.round(usd * 100) / 100, 0, t.id || '');
                                tokStmt.run(result.lastInsertRowid, 'supply', t.symbol || '?', t.symbol || '?', t.name || '', t.id || '', t.amount || 0, t.price || 0, usd);
                                walletPositions++;
                                console.log(`    + ${t.symbol}: $${usd.toLocaleString()} (${protoId})`);
                            }
                        }
                    }
                } catch (e) {}
            }
            await new Promise(r => setTimeout(r, 150));
        }

        if (walletPositions > 0) {
            console.log(`  ${short}: ${walletPositions} positions`);
            totalPositions += walletPositions;
        }
    }

    console.log(`  Total: ${totalPositions} positions`);
    return totalPositions;
}

// Load whale definitions
const WHALES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));

async function main() {
    const label = process.argv[2];
    if (!label || !WHALES[label]) {
        console.error('Usage: node src/scan-whale.js <whale-name>');
        console.error('Available:', Object.keys(WHALES).join(', '));
        process.exit(1);
    }

    const def = WHALES[label];
    let wallets;
    if (Array.isArray(def)) {
        wallets = def;
    } else if (def.vaults) {
        wallets = Object.values(def.vaults).flat();
    } else {
        console.error('Invalid whale definition');
        process.exit(1);
    }

    await scanWallets(wallets, label);

    // Balance verification: compare chain_balance with DB total
    console.log('\n=== Balance Verification ===');
    let totalBalance = 0;
    for (const addr of wallets) {
        const chains = await api(`/v1/user/used_chain_list?id=${addr}`);
        for (const c of chains) {
            const bal = await api(`/v1/user/chain_balance?id=${addr}&chain_id=${c.id}`);
            if ((bal.usd_value || 0) >= 50000) totalBalance += bal.usd_value;
            await new Promise(r => setTimeout(r, 100));
        }
    }

    const dbTotal = db.prepare('SELECT COALESCE(SUM(net_usd), 0) as total FROM positions WHERE wallet IN (' + wallets.map(() => '?').join(',') + ')').get(...wallets).total;
    const gap = totalBalance - dbTotal;
    const gapPct = totalBalance > 0 ? (gap / totalBalance * 100) : 0;

    console.log(`  Chain balance (>$50K): $${totalBalance.toLocaleString()}`);
    console.log(`  DB total:              $${dbTotal.toLocaleString()}`);
    console.log(`  Gap:                   $${gap.toLocaleString()} (${gapPct.toFixed(1)}%)`);

    if (gapPct > 5) {
        console.log(`  ⚠️ Gap > 5% — check for missing positions or wallet-held tokens`);
    } else {
        console.log(`  ✅ Within tolerance`);
    }

    db.close();
}

main();
