import { Router, Request, Response } from 'express';
import { Block } from '../models/Block';
import { SyncState } from '../models/SyncState';
import { Transaction } from '../models/Transaction';
import { config } from '../config';
import { withCachePolicy } from '../middleware/cachePolicy';
import { getChainTip } from '../services/chainTip.service';
import { rpcService } from '../services/rpc.service';
import { getStatsData } from '../services/stats.service';
import { withBlockProducers } from '../services/blockRoles.service';
import { stakerOf, type RoleTx } from '../utils/blockRoles';
import { normalizeBlockAmounts, normalizeTransactionAmounts } from '../utils/amounts';
import { sendInternalError } from '../utils/validation';
import { mapPublicSyncError } from '../utils/publicSyncError';

const router = Router();

// The two lists on the home page show the same number of rows.
const BLOCKS_LIMIT = 10;
const TXS_LIMIT = 10;
// "Hide rewards" lists the latest transactions that are neither a block reward nor a stake, found
// among this many latest non-coinbase transactions.
const TRANSFER_SCAN = 200;
const TTL_MS = Math.max(15_000, Math.min(30_000, config.cache.ttlSeconds * 2000));
const STALE_MAX_MS = Math.max(TTL_MS * 4, 120_000);

const BLOCK_LIST_PROJECTION = {
  hash: 1,
  height: 1,
  time: 1,
  nTx: 1,
  difficulty: 1,
  totalValueOutSat: 1,
  minedBy: 1,
  rewardSat: 1,
  size: 1,
  // The first two transactions name the block's producer (withBlockProducers).
  txids: { $slice: 2 },
};

const TX_LIST_PROJECTION = {
  txid: 1,
  blockheight: 1,
  blocktime: 1,
  totalValueOutSat: 1,
  totalValueInSat: 1,
  feeSat: 1,
  isCoinbase: 1,
  size: 1,
  // What the client needs to tell a stake from a transfer (classifyTransaction).
  'vin.address': 1,
  'vout.valueSat': 1,
  'vout.scriptPubKey.type': 1,
  'vout.scriptPubKey.addresses': { $slice: 1 },
};

// What stakerOf needs, so that stakes can be left out of the transfers list.
const TRANSFER_SCAN_PROJECTION = {
  ...TX_LIST_PROJECTION,
  'vout.scriptPubKey.hex': 1,
  'vout.scriptPubKey.addresses': 1,
};

function withBlockConfirmations<T extends { height: number; confirmations?: number }>(
  block: T,
  bestHeight: number
): T {
  (block as Record<string, unknown>).confirmations = Math.max(0, bestHeight - block.height + 1);
  return block;
}

function withTxConfirmations<T extends { blockheight: number; confirmations?: number }>(
  tx: T,
  bestHeight: number
): T {
  (tx as Record<string, unknown>).confirmations = Math.max(0, bestHeight - tx.blockheight + 1);
  return tx;
}

type DashboardPayload = {
  success: true;
  data: {
    stats: Awaited<ReturnType<typeof getStatsData>>;
    sync: {
      isRunning: boolean;
      lastSyncedHeight: number;
      daemonHeight: number;
      blocksRemaining: number;
      progress: number;
      error: string | null;
    };
    blocks: Array<Record<string, unknown>>;
    txs: Array<Record<string, unknown>>;
    /** The latest transactions that are neither a block reward nor a stake (for "Hide rewards"). */
    transfers: Array<Record<string, unknown>>;
  };
};

let cached: { atMs: number; payload: DashboardPayload } | null = null;
let inFlight: Promise<DashboardPayload> | null = null;

async function buildDashboardPayload(): Promise<DashboardPayload> {
  const [stats, tip, blocks, txs, transferCandidates, syncState, daemonHeightResult] = await Promise.all([
    getStatsData(),
    getChainTip(),
    Block.find()
      .sort({ height: -1 })
      .limit(BLOCKS_LIMIT)
      .select(BLOCK_LIST_PROJECTION)
      .lean<Array<Record<string, unknown> & { height: number; txids?: unknown }>>()
      .then(withBlockProducers),
    Transaction.find().sort({ blockheight: -1, _id: -1 }).limit(TXS_LIMIT).select(TX_LIST_PROJECTION).lean(),
    Transaction.find({ isCoinbase: false })
      .sort({ blockheight: -1, _id: -1 })
      .limit(TRANSFER_SCAN)
      .select(TRANSFER_SCAN_PROJECTION)
      .lean<Array<Record<string, unknown> & RoleTx & { blockheight: number }>>(),
    SyncState.findOne({ key: 'main' }).lean(),
    rpcService.getBlockCount().catch(() => null),
  ]);

  const bestHeight = tip.height;
  const normalizedBlocks = blocks.map((block) =>
    withBlockConfirmations(normalizeBlockAmounts(block), bestHeight)
  );
  const normalizeTx = (tx: Record<string, unknown> & { blockheight: number }) =>
    withTxConfirmations(normalizeTransactionAmounts(tx, { maxVoutAddresses: 1 }), bestHeight);
  const normalizedTxs = txs.map(normalizeTx);
  const transfers = transferCandidates
    .filter((tx) => stakerOf(tx) == null)
    .slice(0, TXS_LIMIT)
    .map(normalizeTx);

  const daemonHeight = typeof daemonHeightResult === 'number' ? daemonHeightResult : -1;
  const lastSyncedHeight = syncState?.lastSyncedHeight ?? -1;
  const rawProgress = daemonHeight > 0 ? ((lastSyncedHeight + 1) / (daemonHeight + 1)) * 100 : 0;
  const progress = Math.max(0, Math.min(100, rawProgress));

  return {
    success: true,
    data: {
      stats,
      sync: {
        isRunning: syncState?.isRunning ?? false,
        lastSyncedHeight,
        daemonHeight,
        blocksRemaining: daemonHeight >= 0 ? Math.max(0, daemonHeight - lastSyncedHeight) : 0,
        progress: Math.round(progress * 100) / 100,
        error: mapPublicSyncError(syncState?.error, typeof daemonHeightResult === 'number').error,
      },
      blocks: normalizedBlocks,
      txs: normalizedTxs,
      transfers,
    },
  };
}

export async function getDashboardPayload(): Promise<DashboardPayload> {
  if (cached && Date.now() - cached.atMs < TTL_MS) {
    return cached.payload;
  }

  if (!inFlight) {
    inFlight = buildDashboardPayload();
  }

  const activeInFlight = inFlight;
  try {
    const payload = await activeInFlight;
    cached = { atMs: Date.now(), payload };
    return payload;
  } finally {
    if (inFlight === activeInFlight) {
      inFlight = null;
    }
  }
}

export async function prewarmDashboardOverviewCache(): Promise<void> {
  await getDashboardPayload();
}

/**
 * Sync calls this after each indexed block. Keep the short-lived dashboard
 * snapshot warm instead of forcing a cold DB/RPC fan-out on every block.
 */
export function invalidateDashboardCache(): void {
  // TTL-based refresh keeps the UI fresh enough while avoiding cache stampedes
  // during active chain periods.
  return;
}

router.get('/overview', withCachePolicy('no-store'), async (_req: Request, res: Response) => {
  try {
    const staleFallbackAllowed = !!cached && Date.now() - cached.atMs < STALE_MAX_MS;
    try {
      return res.json(await getDashboardPayload());
    } catch (error) {
      if (staleFallbackAllowed && cached) {
        return res.json(cached.payload);
      }
      throw error;
    }
  } catch (error) {
    sendInternalError(res, 'Failed to fetch dashboard overview', error);
  }
});

export default router;
