#!/usr/bin/env node
/**
 * Reusable Aave-fork RPC scanner helpers.
 * Intended for Spark and similar Aave-v3 style protocols.
 */

const { JsonRpcProvider, Contract, Interface } = require('ethers');

const ADDRESSES_PROVIDER_ABI = [
  'function getPool() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getPriceOracle() view returns (address)',
];

const POOL_ABI = [
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReservesList() view returns (address[])',
];

const DATA_PROVIDER_ABI = [
  'function getAllReservesTokens() view returns (tuple(string symbol, address tokenAddress)[])',
  'function getReserveData(address asset) view returns (uint256 unbacked, uint128 accruedToTreasuryScaled, uint128 totalAToken, uint128 totalStableDebt, uint128 totalVariableDebt, uint128 liquidityRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id)',
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const ORACLE_ABI = [
  'function getAssetPrice(address asset) view returns (uint256)',
];

const contextCache = new Map();
const blockTagCache = new Map();

const ifaceAddressProvider = new Interface(ADDRESSES_PROVIDER_ABI);
const ifacePool = new Interface(POOL_ABI);
const ifaceDataProvider = new Interface(DATA_PROVIDER_ABI);
const ifaceErc20 = new Interface(ERC20_ABI);
const ifaceOracle = new Interface(ORACLE_ABI);

function getRpcUrl(rpcUrl) {
  return rpcUrl || process.env.ALCHEMY_RPC_URL || process.env.ETH_RPC_URL || 'https://eth.drpc.org';
}

function getProvider(rpcUrl) {
  return new JsonRpcProvider(getRpcUrl(rpcUrl));
}

function providerUrl(provider) {
  return String(provider?._getConnection?.().url || provider?.connection?.url || '');
}

function isLimitedBatchRpc(provider) {
  return /drpc\.org/i.test(providerUrl(provider));
}

function isBadRpcResponse(res) {
  return res == null || res === '0x';
}

async function sleep(ms) {
  return await new Promise(r => setTimeout(r, ms));
}

async function safeCall(fn, retries = 3, baseDelayMs = 120) {
  let delay = baseDelayMs;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === retries - 1) break;
      await sleep(delay);
      delay *= 2;
    }
  }
  throw lastErr;
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

async function getPinnedBlockTag(provider) {
  const key = providerUrl(provider) || 'default';
  if (blockTagCache.has(key)) return blockTagCache.get(key);
  const block = await safeCall(() => provider.getBlockNumber(), 3, 100);
  const hexTag = '0x' + block.toString(16);
  blockTagCache.set(key, hexTag);
  return hexTag;
}

async function rawEthCall(provider, to, data) {
  const blockTag = await getPinnedBlockTag(provider);
  return await safeCall(async () => {
    const res = await provider.send('eth_call', [{ to, data }, blockTag]);
    if (isBadRpcResponse(res)) throw new Error('bad rpc response');
    return res;
  }, 4, 150);
}

async function rawCallDecoded(provider, to, iface, fragment, args = []) {
  const data = iface.encodeFunctionData(fragment, args);
  const raw = await rawEthCall(provider, to, data);
  return iface.decodeFunctionResult(fragment, raw);
}

async function resolveAaveForkContracts(providerAddress, provider) {
  if (isLimitedBatchRpc(provider)) {
    const poolAddress = (await rawCallDecoded(provider, providerAddress, ifaceAddressProvider, 'getPool'))[0];
    const dataProviderAddress = (await rawCallDecoded(provider, providerAddress, ifaceAddressProvider, 'getPoolDataProvider'))[0];
    const oracleAddress = (await rawCallDecoded(provider, providerAddress, ifaceAddressProvider, 'getPriceOracle'))[0];
    return {
      addressesProvider: null,
      pool: new Contract(poolAddress, POOL_ABI, provider),
      dataProvider: new Contract(dataProviderAddress, DATA_PROVIDER_ABI, provider),
      oracle: new Contract(oracleAddress, ORACLE_ABI, provider),
      poolAddress,
      dataProviderAddress,
      oracleAddress,
    };
  }

  const addressesProvider = new Contract(providerAddress, ADDRESSES_PROVIDER_ABI, provider);
  const [poolAddress, dataProviderAddress, oracleAddress] = await Promise.all([
    safeCall(() => addressesProvider.getPool()),
    safeCall(() => addressesProvider.getPoolDataProvider()),
    safeCall(() => addressesProvider.getPriceOracle()),
  ]);

  return {
    addressesProvider,
    pool: new Contract(poolAddress, POOL_ABI, provider),
    dataProvider: new Contract(dataProviderAddress, DATA_PROVIDER_ABI, provider),
    oracle: new Contract(oracleAddress, ORACLE_ABI, provider),
    poolAddress,
    dataProviderAddress,
    oracleAddress,
  };
}

async function getReserves(dataProvider, pool, provider, dataProviderAddress, poolAddress) {
  try {
    if (isLimitedBatchRpc(provider)) {
      const tokens = (await rawCallDecoded(provider, dataProviderAddress, ifaceDataProvider, 'getAllReservesTokens'))[0];
      return tokens.map(t => ({ symbol: t.symbol, address: t.tokenAddress }));
    }
    const tokens = await safeCall(() => dataProvider.getAllReservesTokens());
    return tokens.map(t => ({ symbol: t.symbol, address: t.tokenAddress }));
  } catch {
    const reserveList = isLimitedBatchRpc(provider)
      ? (await rawCallDecoded(provider, poolAddress, ifacePool, 'getReservesList'))[0]
      : await safeCall(() => pool.getReservesList());
    const concurrency = isLimitedBatchRpc(provider) ? 1 : 5;
    return await mapWithConcurrency(reserveList, concurrency, async (address) => {
      try {
        if (isLimitedBatchRpc(provider)) {
          const symbol = (await rawCallDecoded(provider, address, ifaceErc20, 'symbol'))[0];
          const decimals = (await rawCallDecoded(provider, address, ifaceErc20, 'decimals'))[0];
          return { address, symbol, decimals: Number(decimals) };
        }
        const token = new Contract(address, ERC20_ABI, provider);
        const [symbol, decimals] = await Promise.all([
          safeCall(() => token.symbol()),
          safeCall(() => token.decimals()),
        ]);
        return { address, symbol, decimals: Number(decimals) };
      } catch {
        return { address, symbol: '?', decimals: null };
      }
    });
  }
}

async function buildReserveMetadata(reserves, dataProvider, oracle, provider, dataProviderAddress, oracleAddress) {
  const concurrency = isLimitedBatchRpc(provider) ? 1 : 5;
  return await mapWithConcurrency(reserves, concurrency, async (reserve) => {
    try {
      if (isLimitedBatchRpc(provider)) {
        const underlyingDecimals = reserve.decimals != null
          ? reserve.decimals
          : Number((await rawCallDecoded(provider, reserve.address, ifaceErc20, 'decimals'))[0]);
        const reserveData = await rawCallDecoded(provider, dataProviderAddress, ifaceDataProvider, 'getReserveData', [reserve.address]);
        const rawPrice = (await rawCallDecoded(provider, oracleAddress, ifaceOracle, 'getAssetPrice', [reserve.address]))[0];
        return {
          address: reserve.address,
          symbol: reserve.symbol,
          decimals: Number(underlyingDecimals),
          aTokenAddress: reserveData[7],
          stableDebtTokenAddress: reserveData[8],
          variableDebtTokenAddress: reserveData[9],
          liquidityRate: reserveData[5],
          oraclePrice: rawPrice,
        };
      }

      const underlying = new Contract(reserve.address, ERC20_ABI, provider);
      const [underlyingDecimals, reserveData, rawPrice] = await Promise.all([
        reserve.decimals != null ? reserve.decimals : safeCall(() => underlying.decimals()),
        safeCall(() => dataProvider.getReserveData(reserve.address)),
        safeCall(() => oracle.getAssetPrice(reserve.address).catch(() => 0n)),
      ]);

      return {
        address: reserve.address,
        symbol: reserve.symbol,
        decimals: Number(underlyingDecimals),
        aTokenAddress: reserveData[7],
        stableDebtTokenAddress: reserveData[8],
        variableDebtTokenAddress: reserveData[9],
        liquidityRate: reserveData[5],
        oraclePrice: rawPrice,
      };
    } catch {
      return {
        address: reserve.address,
        symbol: reserve.symbol,
        decimals: reserve.decimals ?? 18,
        aTokenAddress: null,
        stableDebtTokenAddress: null,
        variableDebtTokenAddress: null,
        liquidityRate: 0n,
        oraclePrice: 0n,
      };
    }
  });
}

async function getAaveForkContext(providerAddress, provider) {
  const key = `${providerAddress.toLowerCase()}::${providerUrl(provider)}`;
  if (contextCache.has(key)) return contextCache.get(key);

  const contracts = await resolveAaveForkContracts(providerAddress, provider);
  const reserves = await getReserves(contracts.dataProvider, contracts.pool, provider, contracts.dataProviderAddress, contracts.poolAddress);
  const reserveMeta = await buildReserveMetadata(reserves, contracts.dataProvider, contracts.oracle, provider, contracts.dataProviderAddress, contracts.oracleAddress);

  const value = { contracts, reserveMeta };
  contextCache.set(key, value);
  return value;
}

function priceToUsd(rawPrice, decimals, amount) {
  if (!rawPrice || !amount) return 0;
  return (Number(amount) * Number(rawPrice)) / 1e8;
}

async function scanAaveForkWallet({ wallet, label, chain, chainId, providerAddress, protocolName, protocolId, provider }) {
  const positions = [];
  const { contracts, reserveMeta } = await getAaveForkContext(providerAddress, provider);
  const accountData = isLimitedBatchRpc(provider)
    ? await rawCallDecoded(provider, contracts.poolAddress, ifacePool, 'getUserAccountData', [wallet])
    : await safeCall(() => contracts.pool.getUserAccountData(wallet));
  const healthFactor = accountData[5] > 0n ? Number(accountData[5]) / 1e18 : null;

  const concurrency = isLimitedBatchRpc(provider) ? 1 : 5;
  const reserveResults = await mapWithConcurrency(reserveMeta, concurrency, async (reserve) => {
    try {
      if (isLimitedBatchRpc(provider)) {
        const userData = await rawCallDecoded(provider, contracts.dataProviderAddress, ifaceDataProvider, 'getUserReserveData', [reserve.address, wallet]);
        const aTokenBal = reserve.aTokenAddress ? (await rawCallDecoded(provider, reserve.aTokenAddress, ifaceErc20, 'balanceOf', [wallet]))[0] : 0n;
        const stableDebtBal = reserve.stableDebtTokenAddress ? (await rawCallDecoded(provider, reserve.stableDebtTokenAddress, ifaceErc20, 'balanceOf', [wallet]))[0] : 0n;
        const variableDebtBal = reserve.variableDebtTokenAddress ? (await rawCallDecoded(provider, reserve.variableDebtTokenAddress, ifaceErc20, 'balanceOf', [wallet]))[0] : 0n;
        return { reserve, userData, aTokenBal, stableDebtBal, variableDebtBal };
      }

      const [userData, aTokenBal, stableDebtBal, variableDebtBal] = await Promise.all([
        safeCall(() => contracts.dataProvider.getUserReserveData(reserve.address, wallet)),
        reserve.aTokenAddress ? safeCall(() => new Contract(reserve.aTokenAddress, ERC20_ABI, provider).balanceOf(wallet).catch(() => 0n)) : 0n,
        reserve.stableDebtTokenAddress ? safeCall(() => new Contract(reserve.stableDebtTokenAddress, ERC20_ABI, provider).balanceOf(wallet).catch(() => 0n)) : 0n,
        reserve.variableDebtTokenAddress ? safeCall(() => new Contract(reserve.variableDebtTokenAddress, ERC20_ABI, provider).balanceOf(wallet).catch(() => 0n)) : 0n,
      ]);
      return { reserve, userData, aTokenBal, stableDebtBal, variableDebtBal };
    } catch {
      return null;
    }
  });

  for (const row of reserveResults) {
    if (!row) continue;
    const { reserve, userData, aTokenBal, stableDebtBal, variableDebtBal } = row;

    const suppliedRaw = aTokenBal > 0n ? aTokenBal : userData[0] || userData.currentATokenBalance;
    const stableDebtRaw = stableDebtBal > 0n ? stableDebtBal : userData[1] || userData.currentStableDebt;
    const variableDebtRaw = variableDebtBal > 0n ? variableDebtBal : userData[2] || userData.currentVariableDebt;
    const liquidityRate = userData[6] || userData.liquidityRate || reserve.liquidityRate || 0n;
    const stableBorrowRate = userData[5] || userData.stableBorrowRate || 0n;
    const collateralEnabled = userData[8] ?? userData.usageAsCollateralEnabled;

    if (suppliedRaw > 0n) {
      const amount = Number(suppliedRaw) / (10 ** reserve.decimals);
      positions.push({
        wallet, label, chain, chainId,
        protocol_name: protocolName,
        protocol_id: protocolId,
        position_type: 'supply',
        strategy: 'Lend',
        symbol: reserve.symbol,
        token_address: reserve.address,
        amount,
        value_usd: priceToUsd(reserve.oraclePrice, reserve.decimals, amount),
        apy_base: Number(liquidityRate) / 1e25,
        is_collateral: collateralEnabled,
        health_factor: healthFactor,
      });
    }

    const totalDebtRaw = stableDebtRaw + variableDebtRaw;
    if (totalDebtRaw > 0n) {
      const amount = Number(totalDebtRaw) / (10 ** reserve.decimals);
      positions.push({
        wallet, label, chain, chainId,
        protocol_name: protocolName,
        protocol_id: protocolId,
        position_type: 'borrow',
        strategy: 'Borrow',
        symbol: reserve.symbol,
        token_address: reserve.address,
        amount,
        value_usd: priceToUsd(reserve.oraclePrice, reserve.decimals, amount),
        apy_base: Number(stableBorrowRate) / 1e25,
        is_collateral: false,
        health_factor: healthFactor,
      });
    }
  }

  return { positions, accountData, reserveCount: reserveMeta.length };
}

module.exports = {
  getProvider,
  resolveAaveForkContracts,
  getReserves,
  buildReserveMetadata,
  getAaveForkContext,
  scanAaveForkWallet,
  ERC20_ABI,
};
