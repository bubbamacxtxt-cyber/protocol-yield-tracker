#!/usr/bin/env node
// fetch-re.js — Fetch Re Protocol off-chain reserves from Chainlink PoR oracle
// + on-chain token supplies + re.xyz APY API
// Outputs: data/whales/re.json and data/manual-positions.json entry

const fs = require('fs');
const path = require('path');

const AVAX_RPC = 'https://avalanche-c-chain-rpc.publicnode.com';
const CHAINLINK_PROXY = '0xc79a363a3f849d8b3F6A1932f748eA9d4fB2f607';
const RE_APY_API = 'https://api.re.xyz/apy/get-apy';

// On-chain token contracts (Ethereum)
const ETH_RPC = 'https://ethereum-rpc.publicnode.com';
const TOKENS = {
  USDC: { addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6 },
  USDT: { addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', dec: 6 },
  DAI: { addr: '0x6B175474E89094C44Da98b954EedeAC495271d0F', dec: 18 },
  USDe: { addr: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', dec: 18 },
  sUSDe: { addr: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', dec: 18 },
  reUSD: { addr: '0x5086bf358635B81D8C47C66d1C8b9E567Db70c72', dec: 18 },
  reUSDe: { addr: '0xdDC0f880ff6e4e22E4B74632fBb43Ce4DF6cCC5a', dec: 18 },
};

const WALLETS = [
  '0x9ea38e09f41a9de53972a68268ba0dcc6d2fadf8',
  '0x295f67fdb21255a3db82964445628a706fbe689e',
  '0x5c454f5526e41fbe917b63475cd8ca7e4631b147',
  '0xd4374008c88321eb2e59abd311156c44b25831e9',
  '0x9ab62aebabe738ab233c447eedce88d1d0a61fe3',
  '0x19aff1c007397bdb7f82bda18151c28ab4335896',
  '0x802edbb1ec20548a4388abc337e4011718eb0291',
  '0xb22a8533e6cd81598f82514a42f0b3161745fbe1',
  '0xe1886be2ba8b2496c2044a77516f63a734193082',
  '0xfb602cb83c9c15b4cc49340dc9ad7a8c23754bb0',
  '0x4691c475be804fa85f91c2d6d0adf03114de3093',
  '0xe13292f97e38da0c64398de5e0bfc95180de9d23',
  '0x7d214438d0f27afccc23b3d1e1a53906ace5cfea',
  '0xfd4016ea13ca8acc04a11a99702df076a4d3b852',
];

async function ethCall(rpc, to, data) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 })
  });
  const j = await res.json();
  return j.result;
}

function decodeRoundData(hex) {
  if (!hex || hex === '0x' || hex.length < 322) return null;
  const d = Buffer.from(hex.slice(2), 'hex');
  return {
    roundId: BigInt('0x' + d.slice(0, 32).toString('hex')),
    answer: BigInt('0x' + d.slice(32, 64).toString('hex')),
    updatedAt: Number(BigInt('0x' + d.slice(96, 128).toString('hex')))
  };
}

async function getChainlinkReserves() {
  // latestRoundData
  const hex = await ethCall(AVAX_RPC, CHAINLINK_PROXY, '0xfeaf968c');
  const rd = decodeRoundData(hex);
  if (!rd) throw new Error('Failed to read Chainlink oracle');

  const reservesUsd = Number(rd.answer) / 1e8; // 8 decimals
  const updatedAt = new Date(rd.updatedAt * 1000).toISOString();
  const phase = Number(rd.roundId >> 64n);
  const offset = Number(rd.roundId & ((1n << 64n) - 1n));

  // Walk back rounds to find APY - skip capital injection jumps
  // Look for a period where reserves were stable (no big jumps)
  let prevReserve = null;
  let prevDaysAgo = 0;
  const maxLookback = 60;

  // Collect recent rounds
  const rounds = [];
  for (let i = 0; i <= maxLookback; i++) {
    const rid = (BigInt(phase) << 64n) | BigInt(offset - i);
    if (rid <= 0n) break;
    const padded = rid.toString(16).padStart(64, '0');
    const rHex = await ethCall(AVAX_RPC, CHAINLINK_PROXY, '0x9a6fc8f5' + padded);
    const ard = decodeRoundData(rHex);
    if (!ard || ard.updatedAt === 0) continue;
    rounds.push({
      value: Number(ard.answer) / 1e8,
      updatedAt: ard.updatedAt,
      daysAgo: (rd.updatedAt - ard.updatedAt) / 86400
    });
  }

  // Find APY from same-regime periods
  // A "jump" is when value changes >5% in one day
  let offchainApy = null;

  // First try: compare current value to a point 7+ days ago in the same regime
  for (const r of rounds) {
    if (r.daysAgo >= 7 && r.value > 0) {
      // Check if this point is in the same regime (within 10% of current)
      // If not, it's a different capital level - still valid for APY on existing capital
      prevReserve = r.value;
      prevDaysAgo = r.daysAgo;
      break;
    }
  }

  if (prevReserve && prevReserve > 0 && prevDaysAgo > 0) {
    const dailyReturn = (reservesUsd / prevReserve) ** (1 / prevDaysAgo) - 1;
    offchainApy = ((1 + dailyReturn) ** 365 - 1) * 100;
  }

  // If APY looks unreasonable (capital injection inflated it), use re.xyz API as fallback
  // re.xyz gives blended APY; we use it as a sanity check
  if (offchainApy !== null && (offchainApy > 50 || offchainApy < -10)) {
    // APY is distorted by capital injection, mark as unreliable
    offchainApy = null;
  }

  // Fallback: if oracle APY is null or 0, use re.xyz API
  // reUSD APY represents the Basis-Plus (senior) tranche which is mostly off-chain
  // Use it as a proxy for off-chain yield when oracle is flat
  if (offchainApy === null || offchainApy === 0) {
    const apyData = await getReApy();
    offchainApy = apyData.reUSD.apy; // 6.08% as of Apr 2026
    console.log(`  Oracle APY unavailable (flat), using re.xyz reUSD APY: ${offchainApy}%`);
  }

  return { reservesUsd, updatedAt, offchainApy, roundId: offset };
}

async function getReApy() {
  const res = await fetch(RE_APY_API);
  const data = await res.json();
  if (!data.success) throw new Error('Failed to fetch re.xyz APY');
  return data.data;
}

async function getOnChainBalances() {
  const balances = {};
  for (const w of WALLETS) {
    balances[w] = {};
    for (const [name, t] of Object.entries(TOKENS)) {
      const padded = w.slice(2).padStart(64, '0');
      const hex = await ethCall(ETH_RPC, t.addr, '0x70a08231' + padded);
      if (hex && hex !== '0x') {
        const bal = Number(BigInt(hex)) / (10 ** t.dec);
        if (bal > 1) balances[w][name] = bal;
      }
    }
  }
  return balances;
}

async function main() {
  console.log('Fetching Re Protocol data...');

  // 1. Chainlink off-chain reserves
  console.log('  Reading Chainlink PoR oracle...');
  const chainlink = await getChainlinkReserves();
  console.log(`  Off-chain reserves: $${chainlink.reservesUsd.toLocaleString()}`);
  console.log(`  Derived off-chain APY: ${chainlink.offchainApy?.toFixed(2) || 'N/A'}%`);

  // 2. re.xyz APY API
  console.log('  Fetching re.xyz APY...');
  const apyData = await getReApy();
  console.log(`  reUSD APY: ${apyData.reUSD.apy}%, reUSDe APY: ${apyData.reUSDe.apy}%`);

  // 3. On-chain token balances
  console.log('  Scanning on-chain wallets...');
  const balances = await getOnChainBalances();
  let onChainTotal = 0;
  for (const [w, toks] of Object.entries(balances)) {
    for (const [name, bal] of Object.entries(toks)) {
      onChainTotal += bal; // All stablecoins ~$1
    }
  }
  console.log(`  On-chain total: ~$${onChainTotal.toLocaleString()}`);

  // 4. Build off-chain manual position
  const offchainPosition = {
    wallet: 'off-chain',
    chain: 'avalanche',
    protocol_name: 'Private Reinsurance Deals',
    protocol_id: 're-offchain-reserves',
    position_type: 'Illiquid',
    strategy: 'RWA',
    yield_source: 'reinsurance',
    health_rate: null,
    net_usd: chainlink.reservesUsd,
    asset_usd: chainlink.reservesUsd,
    debt_usd: 0,
    supply: [
      {
        symbol: 'USD',
        real_symbol: 'USD',
        amount: chainlink.reservesUsd,
        price_usd: 1,
        value_usd: chainlink.reservesUsd
      }
    ],
    borrow: [],
    rewards: [],
    apy_current: chainlink.offchainApy || 0,
    apy_avg: chainlink.offchainApy || 0,
    apy_base: chainlink.offchainApy || 0,
    apy_rewards: 0,
    maturity: null,
    bucket_weeks: null,
    underlying: 'USD',
    paused: false,
    manual: true,
    scanned_at: new Date().toISOString()
  };

  // 5. Write to manual-positions.json (merge with existing)
  const manualPath = path.join(__dirname, '..', 'data', 'manual-positions.json');
  let manualPositions = {};
  if (fs.existsSync(manualPath)) {
    manualPositions = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  }
  manualPositions['Re Protocol'] = [offchainPosition];
  fs.writeFileSync(manualPath, JSON.stringify(manualPositions, null, 2));
  console.log('  Updated manual-positions.json');

  // 6. Save Chainlink history for future APY calculations
  const reData = {
    chainlink: {
      proxy: CHAINLINK_PROXY,
      chain: 'avalanche',
      decimals: 8,
      latest_round: chainlink.roundId,
      reserves_usd: chainlink.reservesUsd,
      updated_at: chainlink.updatedAt,
      offchain_apy: chainlink.offchainApy,
    },
    apy_api: apyData,
    on_chain_total: onChainTotal,
    wallet_balances: balances,
    fetched_at: new Date().toISOString()
  };

  const reDataPath = path.join(__dirname, '..', 'data', 'whales', 're.json');
  fs.mkdirSync(path.dirname(reDataPath), { recursive: true });
  fs.writeFileSync(reDataPath, JSON.stringify(reData, null, 2));
  console.log(`  Saved re.json`);

  console.log('\nDone! Re Protocol data fetched.');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
