import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Transaction } from '../models/Transaction';
import { config } from '../config';
import { getChainTip } from '../services/chainTip.service';
import { withCachePolicy } from '../middleware/cachePolicy';
import { normalizeTransactionAmounts } from '../utils/amounts';
import {
  firstValidationIssueMessage,
  parseLatestCountQuery,
  parsePaginationQuery,
  sendInternalError,
  sendValidationError,
  txidParamSchema,
} from '../utils/validation';

const router = Router();
const LATEST_TXS_TTL_MS = Math.max(1000, Math.min(10_000, config.cache.ttlSeconds * 1000));
const LATEST_TXS_STALE_MAX_MS = Math.max(LATEST_TXS_TTL_MS * 4, 60_000);
const latestTxsCache = new Map<number, { atMs: number; data: Array<Record<string, unknown>> }>();
const latestTxsInFlight = new Map<number, Promise<Array<Record<string, unknown>>>>();
const TX_DETAIL_TTL_MS = Math.max(1000, Math.min(20_000, config.cache.ttlSeconds * 2_000));
const TX_DETAIL_STALE_MAX_MS = Math.max(TX_DETAIL_TTL_MS * 4, 120_000);
const TX_DETAIL_CACHE_LIMIT = 512;
type TxDetail = Record<string, unknown> & { blockheight: number };
// The cache holds the transaction, not the answer: the confirmations are counted from the chain tip
// each time it is served, so a cached transaction does not keep the count it was first read with.
type TxDetailEntry = { atMs: number; tx: TxDetail; bestHeight: number };
const txDetailCache = new Map<string, TxDetailEntry>();
const txDetailInFlight = new Map<string, Promise<TxDetailEntry | null>>();
const TOTAL_TX_COUNT_TTL_MS = 15_000;
let totalTxCountCache: { atMs: number; total: number } | null = null;
let totalTxCountInFlight: Promise<number> | null = null;

function isFresh(cachedAtMs: number, ttlMs: number): boolean {
  return Date.now() - cachedAtMs < ttlMs;
}

function setTxDetailCache(key: string, tx: TxDetail, bestHeight: number): TxDetailEntry {
  if (txDetailCache.has(key)) {
    txDetailCache.delete(key);
  } else if (txDetailCache.size >= TX_DETAIL_CACHE_LIMIT) {
    const oldest = txDetailCache.keys().next().value;
    if (oldest) txDetailCache.delete(oldest);
  }
  const entry = { atMs: Date.now(), tx, bestHeight };
  txDetailCache.set(key, entry);
  return entry;
}

/**
 * The answer for a cached transaction: a copy, with the confirmations counted from the current
 * tip. If the tip cannot be read, the height the transaction was cached with stands in, so a
 * database outage still gets the last known answer.
 */
async function txDetailPayload(entry: TxDetailEntry): Promise<{ success: true; data: TxDetail }> {
  const bestHeight = await getChainTip().then((tip) => tip.height, () => entry.bestHeight);
  return { success: true, data: withTxConfirmations({ ...entry.tx }, bestHeight) };
}

async function getTotalTxCount(): Promise<number> {
  if (totalTxCountCache && isFresh(totalTxCountCache.atMs, TOTAL_TX_COUNT_TTL_MS)) {
    return totalTxCountCache.total;
  }
  if (totalTxCountInFlight) {
    return totalTxCountInFlight;
  }
  totalTxCountInFlight = Transaction.countDocuments()
    .then((total) => {
      totalTxCountCache = { atMs: Date.now(), total };
      return total;
    })
    .finally(() => {
      totalTxCountInFlight = null;
    });
  return totalTxCountInFlight;
}

const TX_LIST_PROJECTION = {
  txid: 1,
  blockheight: 1,
  blocktime: 1,
  totalValueOutSat: 1,
  feeSat: 1,
  isCoinbase: 1,
  'vin.txid': 1,
  'vout.valueSat': 1,
  'vout.scriptPubKey.addresses': { $slice: 1 },
};

function withTxConfirmations<T extends { blockheight: number; confirmations?: number }>(
  tx: T,
  bestHeight: number
): T {
  (tx as Record<string, unknown>).confirmations = Math.max(0, bestHeight - tx.blockheight + 1);
  return tx;
}

router.get('/', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const paginationParsed = parsePaginationQuery(req.query as Record<string, unknown>, {
      page: 1,
      limit: 20,
    });
    if (!paginationParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paginationParsed.error));
    }
    const { page, limit } = paginationParsed.data;
    const skip = (page - 1) * limit;
    const cursorModeRequested =
      req.query.cursor === '1' ||
      req.query.cursor === 'true';
    const cursorBlockheightRaw = req.query.cursorBlockheight;
    const cursorIdRaw = req.query.cursorId;

    let cursorBlockheight: number | null = null;
    if (
      cursorBlockheightRaw !== undefined &&
      cursorBlockheightRaw !== null &&
      String(cursorBlockheightRaw).trim() !== ''
    ) {
      const parsed = Number.parseInt(String(cursorBlockheightRaw), 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return sendValidationError(res, 'cursorBlockheight must be a positive integer');
      }
      cursorBlockheight = parsed;
    }

    let cursorId: string | null = null;
    if (cursorIdRaw !== undefined && cursorIdRaw !== null && String(cursorIdRaw).trim() !== '') {
      const parsed = String(cursorIdRaw).trim();
      if (!mongoose.Types.ObjectId.isValid(parsed)) {
        return sendValidationError(res, 'cursorId must be a valid ObjectId');
      }
      cursorId = parsed;
    }

    if (cursorId && cursorBlockheight == null) {
      return sendValidationError(res, 'cursorBlockheight is required when cursorId is provided');
    }

    if (cursorModeRequested || cursorBlockheight != null) {
      const query: Record<string, unknown> = {};
      if (cursorBlockheight != null && cursorId) {
        query.$or = [
          { blockheight: { $lt: cursorBlockheight } },
          { blockheight: cursorBlockheight, _id: { $lt: new mongoose.Types.ObjectId(cursorId) } },
        ];
      } else if (cursorBlockheight != null) {
        query.blockheight = { $lt: cursorBlockheight };
      }

      const [rows, tip] = await Promise.all([
        Transaction.find(query)
          .sort({ blockheight: -1, _id: -1 })
          .limit(limit + 1)
          .select(TX_LIST_PROJECTION)
          .lean(),
        getChainTip(),
      ]);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const bestHeight = tip.height;
      const data = pageRows.map((tx) =>
        withTxConfirmations(normalizeTransactionAmounts(tx, { maxVoutAddresses: 1 }), bestHeight)
      );
      const lastRow = pageRows.length > 0 ? (pageRows[pageRows.length - 1] as { blockheight: number; _id: unknown }) : null;
      const nextCursor =
        hasMore && lastRow
          ? {
              cursorBlockheight: lastRow.blockheight,
              cursorId: String(lastRow._id),
            }
          : null;

      return res.json({
        success: true,
        data,
        cursor: {
          mode: 'cursor',
          hasMore,
          next: nextCursor,
        },
      });
    }

    const [txs, total, tip] = await Promise.all([
      Transaction.find()
        .sort({ blockheight: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .select(TX_LIST_PROJECTION)
        .lean(),
      getTotalTxCount(),
      getChainTip(),
    ]);
    const bestHeight = tip.height;
    const data = txs.map((tx) =>
      withTxConfirmations(normalizeTransactionAmounts(tx, { maxVoutAddresses: 1 }), bestHeight)
    );

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    sendInternalError(res, 'Failed to fetch transactions', error);
  }
});

router.get('/latest', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const countParsed = parseLatestCountQuery(req.query as Record<string, unknown>, 10);
    if (!countParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(countParsed.error));
    }
    const { count } = countParsed.data;
    const cached = latestTxsCache.get(count);
    if (cached && isFresh(cached.atMs, LATEST_TXS_TTL_MS)) {
      return res.json({ success: true, data: cached.data });
    }

    const staleFallbackAllowed = !!cached && isFresh(cached.atMs, LATEST_TXS_STALE_MAX_MS);
    const inFlight = latestTxsInFlight.get(count);
    if (inFlight) {
      try {
        const dedupedData = await inFlight;
        return res.json({ success: true, data: dedupedData });
      } catch {
        if (staleFallbackAllowed && cached) {
          return res.json({ success: true, data: cached.data });
        }
        throw new Error('Latest transactions in-flight query failed');
      }
    }

    const fetchPromise = (async () => {
      const [txs, tip] = await Promise.all([
        Transaction.find()
          .sort({ blockheight: -1, _id: -1 })
          .limit(count)
          .select(TX_LIST_PROJECTION)
          .lean(),
        getChainTip(),
      ]);
      const bestHeight = tip.height;
      const data = txs.map((tx) =>
        withTxConfirmations(normalizeTransactionAmounts(tx, { maxVoutAddresses: 1 }), bestHeight)
      );
      latestTxsCache.set(count, { atMs: Date.now(), data });
      return data;
    })();

    latestTxsInFlight.set(count, fetchPromise);
    try {
      const data = await fetchPromise;
      return res.json({ success: true, data });
    } catch (error) {
      if (staleFallbackAllowed && cached) {
        return res.json({ success: true, data: cached.data });
      }
      throw error;
    } finally {
      if (latestTxsInFlight.get(count) === fetchPromise) {
        latestTxsInFlight.delete(count);
      }
    }
  } catch (error) {
    sendInternalError(res, 'Failed to fetch transactions', error);
  }
});

router.get('/:txid', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const paramParsed = txidParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paramParsed.error));
    }
    // The schema lowers the id, so it is also the cache key.
    const { txid } = paramParsed.data;
    const normalizedKey = txid;
    const cachedEntry = txDetailCache.get(normalizedKey);
    const cached =
      cachedEntry && isFresh(cachedEntry.atMs, TX_DETAIL_TTL_MS) ? cachedEntry : null;
    if (cached) {
      return res.json(await txDetailPayload(cached));
    }
    const staleCached =
      cachedEntry && isFresh(cachedEntry.atMs, TX_DETAIL_STALE_MAX_MS) ? cachedEntry : null;
    const staleFallbackAllowed = !!staleCached;
    const inFlight = txDetailInFlight.get(normalizedKey);
    if (inFlight) {
      try {
        const dedupedEntry = await inFlight;
        if (!dedupedEntry) {
          return res
            .status(404)
            .json({ success: false, error: { code: 'NOT_FOUND', message: 'Transaction not found' } });
        }
        return res.json(await txDetailPayload(dedupedEntry));
      } catch {
        if (staleFallbackAllowed && staleCached) {
          return res.json(await txDetailPayload(staleCached));
        }
        throw new Error('tx detail in-flight query failed');
      }
    }

    const fetchPromise = (async () => {
      const [tx, tip] = await Promise.all([
        Transaction.findOne({ txid }).lean<Record<string, unknown> & { blockheight: number }>(),
        getChainTip(),
      ]);
      if (!tx) return null;
      return setTxDetailCache(normalizedKey, normalizeTransactionAmounts(tx), tip.height);
    })();

    txDetailInFlight.set(normalizedKey, fetchPromise);
    try {
      const entry = await fetchPromise;
      if (!entry) {
        return res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Transaction not found' } });
      }
      return res.json(await txDetailPayload(entry));
    } catch (error) {
      if (staleFallbackAllowed && staleCached) {
        return res.json(await txDetailPayload(staleCached));
      }
      throw error;
    } finally {
      if (txDetailInFlight.get(normalizedKey) === fetchPromise) {
        txDetailInFlight.delete(normalizedKey);
      }
    }
  } catch (error) {
    sendInternalError(res, 'Failed to fetch transaction', error);
  }
});

export default router;
