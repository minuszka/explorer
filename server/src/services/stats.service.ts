import { COIN, type StatsDataContract } from '@defcon/shared';
import { Address } from '../models/Address';
import { Block } from '../models/Block';
import { Transaction } from '../models/Transaction';
import { config } from '../config';
import { countStakersSince } from './blockRoles.service';
import { getChainTip } from './chainTip.service';
import { fetchRawMasternodes } from './masternode.service';
import { rpcService } from './rpc.service';
import { coinToSat, satToBigInt, satToCoin } from '../utils/amounts';
import { logger } from '../utils/logger';

// Use string range query instead of regex for better index utilization.
const ADDRESS_PREFIX = COIN.ADDRESS_PREFIX;
const ADDRESS_PREFIX_NEXT = String.fromCharCode(
  ADDRESS_PREFIX.charCodeAt(ADDRESS_PREFIX.length - 1) + 1
);
const LEGACY_ADDRESS_FILTER = {
  $gte: ADDRESS_PREFIX,
  $lt: ADDRESS_PREFIX.slice(0, -1) + ADDRESS_PREFIX_NEXT,
};

type MasternodeCountResult =
  | number
  | string
  | {
      enabled?: number;
      active?: number;
      total?: number;
      count?: number;
    };

type MasternodeListResult = Record<string, unknown>;

type RpcNetworkInfo = {
  connections?: number;
};

type RpcMempoolInfo = {
  size?: number;
  bytes?: number;
};

type RpcBlockchainInfo = {
  moneysupply?: number;
  mint?: number;
  difficulty?: number;
  blocks?: number;
};

export type StatsData = StatsDataContract;

function toFiniteInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const direct = Number(trimmed);
    if (Number.isFinite(direct)) return Math.trunc(direct);
    const match = trimmed.match(/-?\d+/);
    if (match) {
      const parsed = Number.parseInt(match[0], 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function parseMasternodeCount(result: MasternodeCountResult): number | null {
  const primitive = toFiniteInt(result);
  if (primitive != null) return primitive;

  if (result && typeof result === 'object') {
    const typed = result as Record<string, unknown>;
    const preferredKeys = ['enabled', 'active', 'total', 'count'] as const;
    for (const key of preferredKeys) {
      const parsed = toFiniteInt(typed[key]);
      if (parsed != null) return parsed;
    }

    // Some daemons wrap count fields inside a nested object.
    for (const nestedKey of ['result', 'masternodes', 'stats'] as const) {
      const nested = typed[nestedKey];
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
      const nestedRecord = nested as Record<string, unknown>;
      for (const key of preferredKeys) {
        const parsed = toFiniteInt(nestedRecord[key]);
        if (parsed != null) return parsed;
      }
    }
  }

  return null;
}

function isActiveMasternodeStatus(status: unknown): boolean {
  const normalized = String(status || '').trim().split(/\s+/)[0]?.toUpperCase();
  return normalized === 'ENABLED' || normalized === 'POSE_PENALTY';
}

function isActiveMasternode(value: unknown): boolean {
  if (typeof value === 'string') {
    return isActiveMasternodeStatus(value);
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const status = record.status ?? record.state ?? record.Status ?? record.State;
    return isActiveMasternodeStatus(status);
  }

  return false;
}

function countActiveMasternodes(result: unknown): number | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;

  return Object.values(result as MasternodeListResult).filter(isActiveMasternode).length;
}

async function tryGetActiveMasternodes(): Promise<number | undefined> {
  try {
    const nodes = await fetchRawMasternodes();
    if (nodes.length > 0) {
      return nodes.filter((node) => isActiveMasternodeStatus(node.status)).length;
    }
  } catch {
    // Fall back to daemon count methods below if the shared masternode snapshot fails.
  }

  const attempts: Array<() => Promise<MasternodeCountResult>> = [
    () =>
      rpcService.call<unknown>('masternodelist', ['status']).then((result) => {
        const enabled = countActiveMasternodes(result);
        return enabled ?? (result as MasternodeCountResult);
      }),
    () =>
      rpcService.call<unknown>('masternodelist', ['full']).then((result) => {
        const enabled = countActiveMasternodes(result);
        return enabled ?? (result as MasternodeCountResult);
      }),
    () => rpcService.call<MasternodeCountResult>('masternode', ['count']),
    () => rpcService.call<MasternodeCountResult>('getmasternodecount'),
    () =>
      rpcService
        .call<unknown>('protx', ['list', 'valid'])
        .then((result) => (Array.isArray(result) ? result.length : (result as MasternodeCountResult))),
    () =>
      rpcService
        .call<unknown>('protx', ['list', 'registered'])
        .then((result) => (Array.isArray(result) ? result.length : (result as MasternodeCountResult))),
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      const parsed = parseMasternodeCount(result as MasternodeCountResult);
      if (parsed != null && parsed >= 0) return parsed;
    } catch {
      // try next method
    }
  }

  return undefined;
}

let cached: { atMs: number; data: StatsData } | null = null;
let inFlight: Promise<StatsData> | null = null;
// Refresh by TTL, not on every indexed block, to keep the dashboard cache hot.
const STATS_TTL_MS = Math.max(30_000, Math.max(0, config.cache.ttlSeconds) * 3000);

export async function getStatsData(forceRefresh = false): Promise<StatsData> {
  const now = Date.now();
  if (!forceRefresh && cached && STATS_TTL_MS > 0 && now - cached.atMs < STATS_TTL_MS) {
    return cached.data;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const chainTip = await getChainTip();
    const nowTs = Math.floor(Date.now() / 1000);
    const oneDayAgo = nowTs - 86400;
    const sevenDaysAgo = nowTs - 7 * 86400;
    const thirtyDaysAgo = nowTs - 30 * 86400;

  // Three parallel aggregations replacing 6 sequential/partial-parallel DB round-trips:
  //  txFacet:    total TX count + 24h TX count
  //  addrFacet:  total addresses (with balance) + 24h new + 7d new
  //  blockFacet: 30d TX trend + 24h value transferred
    const [latestBlock, [txFacet], [addrFacet], [blockFacet]] = await Promise.all([
      Block.findOne({ height: chainTip.height }).lean(),
      Transaction.aggregate<{
        total: Array<{ n: number }>;
        last24h: Array<{ n: number }>;
      }>([
        {
          $facet: {
            total: [{ $count: 'n' }],
            last24h: [{ $match: { blocktime: { $gte: oneDayAgo } } }, { $count: 'n' }],
          },
        },
      ]),
      Address.aggregate<{
        withBalance: Array<{ n: number }>;
        new24h: Array<{ n: number }>;
        new7d: Array<{ n: number }>;
      }>([
        { $match: { address: LEGACY_ADDRESS_FILTER } },
        {
          $facet: {
            withBalance: [{ $match: { balanceSat: { $gt: 0 } } }, { $count: 'n' }],
            new24h: [{ $match: { firstSeen: { $gte: oneDayAgo } } }, { $count: 'n' }],
            new7d: [{ $match: { firstSeen: { $gte: sevenDaysAgo } } }, { $count: 'n' }],
          },
        },
      ]),
      Block.aggregate<{
        trend: Array<{ _id: string; txCount: number; blockCount: number }>;
        value24h: Array<{ totalSat: number }>;
        flow24h: Array<{ _id: string; txCount: number; blockCount: number }>;
      }>([
        { $match: { time: { $gte: thirtyDaysAgo } } },
        {
          $facet: {
            trend: [
              {
                $project: {
                  day: {
                    $dateToString: {
                      format: '%Y-%m-%d',
                      date: { $toDate: { $multiply: ['$time', 1000] } },
                    },
                  },
                  nTx: { $ifNull: ['$nTx', 0] },
                },
              },
              { $group: { _id: '$day', txCount: { $sum: '$nTx' }, blockCount: { $sum: 1 } } },
              { $sort: { _id: 1 } },
            ],
            value24h: [
              { $match: { time: { $gte: oneDayAgo } } },
              {
                $group: {
                  _id: null,
                  totalSat: {
                    $sum: { $convert: { input: '$totalValueOutSat', to: 'long', onError: 0, onNull: 0 } },
                  },
                },
              },
            ],
            flow24h: [
              { $match: { time: { $gte: oneDayAgo } } },
              {
                $project: {
                  hour: {
                    $dateToString: {
                      format: '%Y-%m-%dT%H:00:00Z',
                      date: { $toDate: { $multiply: ['$time', 1000] } },
                    },
                  },
                  nTx: { $ifNull: ['$nTx', 0] },
                },
              },
              {
                $group: {
                  _id: '$hour',
                  txCount: { $sum: '$nTx' },
                  blockCount: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ]),
    ]);

    const totalTxs = txFacet?.total[0]?.n ?? 0;
    const txCount24h = txFacet?.last24h[0]?.n ?? 0;
    const totalAddresses = addrFacet?.withBalance[0]?.n ?? 0;
    const newAddresses24h = addrFacet?.new24h[0]?.n ?? 0;
    const newAddresses7d = addrFacet?.new7d[0]?.n ?? 0;
    const txTrendAgg = blockFacet?.trend ?? [];
    const flow24hAgg = blockFacet?.flow24h ?? [];
    const totalValueTransferred24hSat = BigInt(blockFacet?.value24h[0]?.totalSat ?? 0);
    const totalValueTransferred24h = satToCoin(totalValueTransferred24hSat);

    const txTrendMap = new Map<string, { txCount: number; blockCount: number }>();
    for (const row of txTrendAgg as Array<{ _id: string; txCount: number; blockCount: number }>) {
      txTrendMap.set(row._id, { txCount: row.txCount || 0, blockCount: row.blockCount || 0 });
    }

    const txTrend30d: Array<{ date: string; count: number }> = [];
    const dayStart = Math.floor(nowTs / 86400) * 86400;
    for (let i = 29; i >= 0; i -= 1) {
      const ts = dayStart - i * 86400;
      const key = new Date(ts * 1000).toISOString().slice(0, 10);
      txTrend30d.push({
        date: key,
        count: txTrendMap.get(key)?.txCount || 0,
      });
    }

    const txCount30d = txTrend30d.reduce((sum, day) => sum + day.count, 0);
    const blockCount30d = Array.from(txTrendMap.values()).reduce(
      (sum, day) => sum + (day.blockCount || 0),
      0
    );
    const avgTxPerBlock30d = blockCount30d > 0 ? Math.round((txCount30d / blockCount30d) * 100) / 100 : 0;

    const flow24hMap = new Map<string, { blocks: number; txs: number }>();
    for (const row of flow24hAgg as Array<{ _id: string; txCount: number; blockCount: number }>) {
      flow24hMap.set(row._id, {
        blocks: row.blockCount || 0,
        txs: row.txCount || 0,
      });
    }
    const flow24h: Array<{ hour: string; blocks: number; txs: number }> = [];
    const hourStartMs = Math.floor(Date.now() / 3600000) * 3600000;
    for (let i = 23; i >= 0; i -= 1) {
      const hourMs = hourStartMs - i * 3600000;
      const key = new Date(hourMs).toISOString().slice(0, 13) + ':00:00Z';
      const point = flow24hMap.get(key);
      flow24h.push({
        hour: key,
        blocks: point?.blocks || 0,
        txs: point?.txs || 0,
      });
    }

    // Fetch live data from daemon RPC
    let hashrate = 0;
    let connections = 0;
    let mempoolSize = 0;
    let mempoolBytes = 0;
    let difficulty = latestBlock?.difficulty ?? 0;
    let daemonHeight = latestBlock?.height ?? 0;
    let moneySupply = 0;
    let mintSat = 0n;
    let masternodes: number | undefined;
    let stakingWallets: number | undefined;
    let stakingRewardSat = 0n;

    try {
      const [hashrateRes, networkRes, mempoolRes, diffRes, heightRes, chainRes, masternodeRes] =
        await Promise.allSettled([
          rpcService.getNetworkHashPS(),
          rpcService.getNetworkInfo() as Promise<RpcNetworkInfo>,
          rpcService.getMempoolInfo() as Promise<RpcMempoolInfo>,
          rpcService.getDifficulty(),
          rpcService.getBlockCount(),
          rpcService.getBlockchainInfo() as Promise<RpcBlockchainInfo>,
          tryGetActiveMasternodes(),
        ]);

      if (hashrateRes.status === 'fulfilled') hashrate = hashrateRes.value;
      if (networkRes.status === 'fulfilled') connections = networkRes.value?.connections ?? 0;
      if (mempoolRes.status === 'fulfilled') {
        mempoolSize = mempoolRes.value?.size ?? 0;
        mempoolBytes = mempoolRes.value?.bytes ?? 0;
      }
      if (diffRes.status === 'fulfilled') difficulty = diffRes.value;
      if (heightRes.status === 'fulfilled') daemonHeight = heightRes.value;
      if (chainRes.status === 'fulfilled') {
        moneySupply = chainRes.value?.moneysupply ?? 0;
        mintSat = coinToSat(chainRes.value?.mint ?? 0);
        if (typeof chainRes.value?.difficulty === 'number') {
          difficulty = chainRes.value.difficulty;
        }
        if (typeof chainRes.value?.blocks === 'number') {
          daemonHeight = chainRes.value.blocks;
        }
      }
      if (masternodeRes.status === 'fulfilled') masternodes = masternodeRes.value;
    } catch (err) {
      logger.debug('Could not fetch live RPC data for stats:', err);
    }

    const height = daemonHeight || (latestBlock?.height ?? 0);
    let supply = moneySupply || 0;
    if (supply <= 0) {
      const [supplyAgg] = await Address.aggregate<{ totalSat: number }>([
        { $match: { balanceSat: { $gt: 0 } } },
        {
          $group: {
            _id: null,
            totalSat: {
              $sum: { $convert: { input: '$balanceSat', to: 'long', onError: 0, onNull: 0 } },
            },
          },
        },
      ]);
      if (supplyAgg && supplyAgg.totalSat > 0) {
        supply = satToCoin(BigInt(supplyAgg.totalSat));
      }
    }
    const latestRewardSat = satToBigInt(latestBlock?.rewardSat ?? 0);
    const effectiveBlockRewardSat = latestRewardSat > 0n ? latestRewardSat : mintSat;
    const effectiveBlockReward = satToCoin(effectiveBlockRewardSat);

    if (stakingRewardSat <= 0n && effectiveBlockRewardSat > 0n && COIN.INITIAL_REWARD > 0) {
      const assumedBaseSat = coinToSat(COIN.INITIAL_REWARD);
      if (effectiveBlockRewardSat > assumedBaseSat) {
        stakingRewardSat = effectiveBlockRewardSat - assumedBaseSat;
      }
    }

    // Avg block time from 7-day window (smooths short-term spikes; fallback to constant)
    let avgBlockTime = COIN.BLOCK_TIME_SECONDS;
    const oldestInWindow = await Block.findOne({ time: { $gte: sevenDaysAgo } })
      .sort({ height: 1 })
      .select({ height: 1, time: 1 })
      .lean();
    if (latestBlock && oldestInWindow && latestBlock.height > oldestInWindow.height) {
      const span = latestBlock.time - oldestInWindow.time;
      const blockCount = latestBlock.height - oldestInWindow.height;
      avgBlockTime = Math.round((span / blockCount) * 100) / 100;
    }

    try {
      // Different addresses that staked a block in the last day, read from each coinstake.
      // (`minedBy` is the coinbase payee, which in a proof-of-stake block is the masternode.)
      stakingWallets = await countStakersSince(oneDayAgo);
    } catch {
      // Optional
    }

    const data: StatsData = {
      blockHeight: height,
      lastBlockTime: latestBlock?.time ?? null,
      difficulty,
      hashrate,
      connections,
      mempool: { size: mempoolSize, bytes: mempoolBytes },
      supply: {
        circulating: supply,
        max: COIN.MAX_SUPPLY,
      },
      blockReward: effectiveBlockReward,
      stakingReward: satToCoin(stakingRewardSat),
      avgBlockTime,
      txCount24h,
      totalValueTransferred24h,
      txCount30d,
      avgTxPerBlock30d,
      txTrend30d,
      flow24h,
      newAddresses24h,
      newAddresses7d,
      totalTransactions: totalTxs,
      totalAddresses,
      masternodes,
      stakingWallets,
    };

    cached = { atMs: now, data };
    return data;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
