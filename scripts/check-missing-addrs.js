#!/usr/bin/env node
/**
 * Quick balance check on addresses from DefiLlama adapters that we are
 * NOT currently tracking. For each, call totalSupply() (in case it's
 * a token) and totalAssets() (in case it's a vault) on ETH, Base, Arb,
 * Plasma, Mantle, and print whatever responds.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const RPCS = {
  eth: 'https://eth-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
  base: 'https://base-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
  arb: 'https://arb-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
  plasma: process.env.ALCHEMY_PLASMA_RPC_URL,
  mnt: process.env.ALCHEMY_MNT_RPC_URL,
  avax: 'https://api.avax.network/ext/bc/C/rpc',
};

const MISSING = {
  Reservoir: ['0x1a49bc8464731a08c16edf17f33cf77db37228a4'],
  'Re Protocol': [
    '0x4f1ff9b995472b27a6bafec967986f35bf1adae4',
    '0xc79a363a3f849d8b3f6a1932f748ea9d4fb2f607',
    '0x3094948b3dbe89f4824217e37b8667fbb4d89e18',
  ],
  Upshift: [
    '0x94c2826b24e44f710c5f80e3ed7ce898258d7008',
    '0xfaf4d0ec9b76147c926c0c8b2aba39ea21ec9915',
    '0x323578c2b24683ca845c68c1e2097697d65e2358',
    '0x1fdbd27ba90a7a5385185e3e0b76477202f2cadb',
    '0x30844745c8197fdaf9fe06c4ffeb73fe05c092ce',
  ],
  Superform: [
    '0x4a9e282635567cc4d3c6a24e16c2335f10dee9b8','0xaeeafb1259f01f363d09d7027ad80a9d442de762','0x39a1f8e5d2422ccc5e08c5b4019ab70147f5cc95','0x4ebfc11ad2dd1c2a450ba194558d797ee5d305a6','0x54fa13a38a690bc69584a7ac8b834c1770959974','0x83706a2ec580fe1fdb84744366fa02fb8e25d29d','0xfbadc4f18ddc7ebdbc920d3f9b0ca7a1296788d1','0x7ef4d0168b12b168f14b67c708bc16f7e8bf3dec','0x265329c8f15671d7ca501710e3bd0e6cb257948f','0xd3a17928245064b6df5095a76e277fe441d538a4','0xabc07bf91469c5450d6941dd0770e6e6761b90d6','0x6f28cafe12bd97e474a52bcbfea6f2c18ae0f53d','0x0ace2dc3995acd739ae5e0599e71a5524b93b886','0xb9bfbb35c2ed588a42f9fd1120929c607b463192','0xbc323e3564fb498e55cdc83a3ea6bb1af8402d6b','0x1fd865a55eaf5333e6374fb3ad66d22e9885d3aa','0x866eb09d3d1397b8a28cfe5dceeaed9362840385','0xd63ace62b925361fc588734022718e919a8081ac','0xa135d7f10545e3a45e24e79ecd4e4c3c78cf56bf','0xbc85043544cc2b3fd095d54b6431822979bbb62a','0xd85ec15a9f814d6173bf1a89273bfb3964aadaec','0x10ac0b33e1c4501cf3ec1cb1ae51ebfdbd2d4698',
  ],
  Makina: [
    '0x1e33e98af620f1d563fcd3cfd3c75ace841204ef',
    '0x871ab8e36cae9af35c6a3488b049965233deb7ed',
    '0x972966bcc17f7d818de4f27dc146ef539c231bdf',
    '0xac499adf00a54044b988a59b19016655c3494b06',
  ],
  InfiniFi: ['0x7a5c5dba4fbd0e1e1a2ecdbe752fae55f6e842b3'],
  Yuzu: [
    '0xc8a8df9b210243c55d31c73090f06787ad0a1bf6',
    '0xebfc8c2fe73c431ef2a371aea9132110aab50dca',
  ],
  Avant: ['0x24de8771bc5ddb3362db529fc3358f2df3a0e346'],
};

async function rpc(url, method, params) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const d = await r.json();
    return d.result;
  } catch (e) {
    return null;
  }
}

function parseStr(hex) {
  if (!hex || hex.length < 130) return '';
  try {
    const len = parseInt(hex.slice(66, 130), 16);
    return Buffer.from(hex.slice(130, 130 + len * 2), 'hex').toString('utf8').trim();
  } catch { return ''; }
}

async function checkAddr(chain, url, addr) {
  if (!url) return null;
  // totalAssets() 0x01e1d114, totalSupply() 0x18160ddd, symbol() 0x95d89b41, decimals() 0x313ce567
  const [ta, ts, sym, dec, name] = await Promise.all([
    rpc(url, 'eth_call', [{ to: addr, data: '0x01e1d114' }, 'latest']),
    rpc(url, 'eth_call', [{ to: addr, data: '0x18160ddd' }, 'latest']),
    rpc(url, 'eth_call', [{ to: addr, data: '0x95d89b41' }, 'latest']),
    rpc(url, 'eth_call', [{ to: addr, data: '0x313ce567' }, 'latest']),
    rpc(url, 'eth_call', [{ to: addr, data: '0x06fdde03' }, 'latest']),
  ]);
  const symbol = parseStr(sym || '');
  const fullName = parseStr(name || '');
  const decimals = dec ? parseInt(dec, 16) : 18;
  const taNum = ta && ta !== '0x' ? Number(BigInt(ta)) / 10 ** decimals : null;
  const tsNum = ts && ts !== '0x' ? Number(BigInt(ts)) / 10 ** decimals : null;
  if (!symbol && !taNum && !tsNum) return null;
  return { chain, addr, symbol, fullName, decimals, totalAssets: taNum, totalSupply: tsNum };
}

async function main() {
  for (const [whale, addrs] of Object.entries(MISSING)) {
    console.log(`\n== ${whale} ==`);
    for (const addr of addrs) {
      const results = [];
      for (const [chain, url] of Object.entries(RPCS)) {
        const r = await checkAddr(chain, url, addr);
        if (r && (r.symbol || r.totalAssets || r.totalSupply)) results.push(r);
      }
      if (results.length === 0) {
        console.log(`  ${addr} — nothing found on any chain`);
      } else {
        for (const r of results) {
          const ta = r.totalAssets != null ? `TA:${r.totalAssets.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '';
          const ts = r.totalSupply != null ? `TS:${r.totalSupply.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '';
          console.log(`  ${addr} ${r.chain.padEnd(6)} ${(r.symbol || '?').padEnd(14)} ${(r.fullName || '').slice(0, 30).padEnd(30)} ${ta} ${ts}`);
        }
      }
    }
  }
}

main().catch(e => console.error(e));
