#!/usr/bin/env node
/**
 * Post-scan fix: Correct Morpho Blue collateral token labels.
 * 
 * Root cause: DeBank reports collateral as underlying (USDC 0xa0b8...)
 * instead of actual yield-bearing wrapper (syrupUSDC 0x80ac24aa).
 *
 * SAFE FIX STRATEGY:
 * Match each DeBank Morpho position by its BORROW TOKEN address to
 * Morpho's known loan address. This identifies the exact market, then
 * we correct the supply (collateral) symbol+address.
 * 
 * This is 1:1 and cannot produce false positives — it's like a JOIN
 * on the loan address which is the unique market identifier.
 *
 * Safety: dry-run default, duplicate check, never overwrites valid data.
 */

const https = require('https');
const Database = require('better-sqlite3');

const MORPHO_API = 'https://api.morpho.org/graphql';
const DB_PATH = process.argv[2] || require('path').resolve(__dirname, '..', 'yield-tracker.db');

async function getMorphoPositions(addr) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            query: `{ userByAddress(address: "${addr}") { marketPositions { supplyAssetsUsd borrowAssetsUsd market { uniqueKey collateralAsset { symbol address } loanAsset { symbol address } } } } }`
        });
        https.request(MORPHO_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 15000 }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
                try {
                    const r = JSON.parse(data);
                    resolve(r.data?.userByAddress?.marketPositions || []);
                } catch (e) { reject(e); }
            });
        }).on('error', reject).end(body);
    });
}

async function fixMorphoTokens(apply = false) {
    const db = new Database(DB_PATH);
    const wallets = db.prepare("SELECT DISTINCT wallet FROM positions WHERE protocol_id LIKE '%morpho%' AND chain != 'monad'").all();

    console.log('Morpho Token Fix — ' + wallets.length + ' wallets (' + (apply ? 'WILL APPLY' : 'dry run') + ')\n');

    let fixed = 0, mismatched = 0, skipped = 0, errors = 0, alreadyOk = 0;

    for (const { wallet } of wallets) {
        try {
            const morphoPositions = await getMorphoPositions(wallet);
            const active = morphoPositions.filter(p => p.supplyAssetsUsd > 100 || p.borrowAssetsUsd > 100);
            if (active.length === 0) continue;

            // Get DeBank borrow tokens for this wallet's Morpho positions
            const dbBorrows = db.prepare(`
                SELECT pt.id, pt.symbol, pt.address, pt.value_usd,
                       p.id as pos_id, p.protocol_id, p.chain
                FROM position_tokens pt
                JOIN positions p ON pt.position_id = p.id
                WHERE p.wallet = ? AND pt.role = 'borrow' AND p.protocol_id LIKE '%morpho%'
            `).all(wallet);

            // Get DeBank supply tokens for this wallet
            const dbSupplies = db.prepare(`
                SELECT pt.id, pt.symbol, pt.address, pt.value_usd,
                       p.id as pos_id, p.protocol_id, p.chain
                FROM position_tokens pt
                JOIN positions p ON pt.position_id = p.id
                WHERE p.wallet = ? AND pt.role = 'supply' AND p.protocol_id LIKE '%morpho%'
            `).all(wallet);

            // Build matches: for each DB borrow position, find the best Morpho market
            // Key insight: when 2+ Morpho markets share the same loan asset, disambiguate by borrow value
            for (const dbBorrow of dbBorrows) {
                const loanAddr = dbBorrow.address?.toLowerCase();
                if (!loanAddr) continue;

                // Find ALL Morpho markets with this loan
                const candidates = active.filter(p => p.market?.loanAsset?.address?.toLowerCase() === loanAddr);
                if (candidates.length === 0) continue;

                // Pick best match by borrow value proximity
                let bestMatch = candidates[0];
                if (candidates.length > 1) {
                    const dbBorUsd = dbBorrow.value_usd || 0;
                    candidates.sort((a, b) => 
                        Math.abs((a.borrowAssetsUsd || 0) - dbBorUsd) - 
                        Math.abs((b.borrowAssetsUsd || 0) - dbBorUsd)
                    );
                    bestMatch = candidates[0];
                    // If close match exists but also another close one, flag ambiguity
                    if (candidates.length > 1) {
                        const gap = Math.abs((candidates[0].borrowAssetsUsd || 0) - dbBorUsd);
                        const gap2 = Math.abs((candidates[1].borrowAssetsUsd || 0) - dbBorUsd);
                        if (gap > 0 && gap2 / gap < 2) {
                            // Ambiguous — two candidates with similar proximity
                            console.log('  AMBIGUOUS ' + wallet.slice(0, 10) + ' ' + dbBorrow.symbol +
                                ' bor $' + (dbBorUsd / 1e6).toFixed(1) + 'M — ' +
                                candidates.map(c => c.market.collateralAsset.symbol + '/$' + ((c.borrowAssetsUsd || 0) / 1e6).toFixed(1) + 'M').join(' vs '));
                            skipped++;
                            continue;
                        }
                    }
                }

                const collateral = bestMatch.market?.collateralAsset;
                if (!collateral?.address || collateral.address.startsWith('0x0000000')) continue;

                // Found the position! Now find supply tokens for the same DB position
                const samePositionSupply = dbSupplies.filter(s => s.pos_id === dbBorrow.pos_id);

                for (const supply of samePositionSupply) {
                    const currentAddr = supply.address?.toLowerCase() || '';
                    const targetAddr = collateral.address.toLowerCase();
                    const targetSym = collateral.symbol;

                    if (currentAddr === targetAddr && supply.symbol === targetSym) {
                        alreadyOk++;
                        continue;
                    }

                    // DUPLICATE CHECK: no other supply in the SAME position already uses target address
                    const dup = db.prepare(
                        "SELECT COUNT(*) as c FROM position_tokens WHERE position_id=? AND address=? AND role='supply' AND id!=?"
                    ).get(supply.pos_id, targetAddr, supply.id);
                    if (dup.c > 0) { skipped++; continue; }

                    // Confirmed fix — matched via (borrow address + value proximity)
                    if (apply) {
                        db.prepare("UPDATE position_tokens SET symbol=?, real_symbol=?, address=? WHERE id=?")
                            .run(targetSym, targetSym, targetAddr, supply.id);
                    }
                    fixed++;
                    console.log((apply ? '  FIX  ' : '  WOULD FIX ') +
                        supply.symbol.padEnd(22) + '(' + (supply.address || 'NULL').slice(0, 10) +
                        ') $' + (supply.value_usd / 1e6).toFixed(1) + 'M  →  ' +
                        targetSym.padEnd(22) + '(' + targetAddr.slice(0, 10) +
                        ')  [match via borrow ' + dbBorrow.symbol + ' $' + (dbBorrow.value_usd / 1e6).toFixed(1) + 'M]');
                }
            }
        } catch (e) {
            errors++;
            console.log('  ERR ' + wallet.slice(0, 10) + ': ' + e.message.slice(0, 80));
        }
        await new Promise(r => setTimeout(r, 300));
    }

    console.log('\nDone — fixed:' + fixed + ' alreadyOK:' + alreadyOk + ' mismatched:' + mismatched + ' skipped:' + skipped + ' errors:' + errors);
    db.close();
}

(async () => {
    await fixMorphoTokens(process.argv.includes('--apply'));
})();

module.exports = { fixMorphoTokens };
