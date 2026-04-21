const MORPHO_REST = 'https://app.morpho.org/api';

async function get(url) {
  const res = await fetch(url);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

(async()=>{
  const wallet = process.argv[2];
  const earn = await get(`${MORPHO_REST}/positions/earn?userAddress=${wallet}&limit=500&skip=0&chainIds=1,8453,42161,137,130,747474,999,10,143,988,480&orderBy=assetsUsd&orderDirection=DESC`);
  const borrow = await get(`${MORPHO_REST}/positions/borrow?userAddress=${wallet}&limit=500&skip=0&chainIds=1,8453,42161,137,130,747474,999,10,143,988,480&orderBy=borrowAssetsUsd&orderDirection=DESC`);
  console.log(JSON.stringify({
    earnStatus: earn.status,
    earnCount: earn.json?.items?.length,
    earnFirst: earn.json?.items?.slice?.(0,3),
    borrowStatus: borrow.status,
    borrowCount: borrow.json?.items?.length,
    borrowFirst: borrow.json?.items?.slice?.(0,3),
  }, null, 2));
})();
