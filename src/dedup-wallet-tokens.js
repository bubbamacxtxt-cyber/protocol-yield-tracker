const sqlite3 = require('better-sqlite3');
const path = require('path');

const db = new sqlite3(path.join(__dirname, '..', 'yield-tracker.db'));

// Get all protocol tokens per wallet
const wallets = db.prepare('SELECT DISTINCT wallet FROM positions WHERE protocol_id = ?').all('wallet-held');
console.log(`Checking ${wallets.length} wallets with wallet-held tokens...\n`);

for (const { wallet } of wallets) {
    // Get all protocol token addresses for this wallet
    const protocolTokens = db.prepare(`
        SELECT DISTINCT pt.address FROM position_tokens pt
        JOIN positions p ON pt.position_id = p.id
        WHERE p.wallet = ? AND p.protocol_id != 'wallet-held'
    `).all(wallet).map(t => t.address.toLowerCase());

    // Get wallet-held positions
    const walletPositions = db.prepare(`
        SELECT id FROM positions WHERE wallet = ? AND protocol_id = 'wallet-held'
    `).all(wallet);

    for (const pos of walletPositions) {
        const tokens = db.prepare('SELECT address FROM position_tokens WHERE position_id = ? AND role = ?').all(pos.id, 'supply');
        const tokenAddr = tokens[0]?.address?.toLowerCase();

        // Check if this token address already exists in a protocol position
        if (tokenAddr && protocolTokens.includes(tokenAddr)) {
            console.log(`  Removing duplicate: wallet-held token ${tokenAddr.slice(0, 20)}... already in protocol for ${wallet.slice(0, 8)}...`);
            db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(pos.id);
            db.prepare('DELETE FROM positions WHERE id = ?').run(pos.id);
        }
    }
}

// Also check for same symbol overlap (different contract, same asset)
console.log('\nChecking symbol-level overlaps...');
const allWallets = db.prepare('SELECT DISTINCT wallet FROM positions WHERE protocol_id = ?').all('wallet-held');
for (const { wallet } of allWallets) {
    // Get protocol token symbols
    const protoSyms = db.prepare(`
        SELECT DISTINCT pt.symbol FROM position_tokens pt
        JOIN positions p ON pt.position_id = p.id
        WHERE p.wallet = ? AND p.protocol_id != 'wallet-held' AND pt.role = 'supply'
    `).all(wallet).map(t => t.symbol.toUpperCase());

    // Get wallet-held positions with overlapping symbols
    const walletPos = db.prepare(`
        SELECT p.id, pt.symbol, pt.value_usd, p.chain
        FROM positions p
        JOIN position_tokens pt ON pt.position_id = p.id
        WHERE p.wallet = ? AND p.protocol_id = 'wallet-held' AND pt.role = 'supply'
    `).all(wallet);

    for (const wp of walletPos) {
        // Only remove if same symbol AND same chain as a protocol position
        const protoOnChain = db.prepare(`
            SELECT DISTINCT pt.symbol FROM position_tokens pt
            JOIN positions p ON pt.position_id = p.id
            WHERE p.wallet = ? AND p.protocol_id != 'wallet-held' AND p.chain = ? AND pt.role = 'supply' AND UPPER(pt.symbol) = ?
        `).get(wallet, wp.chain, wp.symbol.toUpperCase());

        if (protoOnChain) {
            console.log(`  Removing overlap: ${wp.symbol} ($${wp.value_usd.toLocaleString()}) on ${wp.chain} — already in protocol`);
            db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(wp.id);
            db.prepare('DELETE FROM positions WHERE id = ?').run(wp.id);
        }
    }
}

db.close();
console.log('\nDone.');
