import { Router, Request, Response } from 'express';
import { Block } from '../models/Block';
import { Transaction } from '../models/Transaction';
import { config } from '../config';
import { getChainTip } from '../services/chainTip.service';
import { loadBlockRoles } from '../services/blockRoles.service';
import { withCachePolicy } from '../middleware/cachePolicy';
import { normalizeBlockAmounts, normalizeTransactionAmounts } from '../utils/amounts';
import {
  blocksRangeQuerySchema,
  firstValidationIssueMessage,
  hashOrHeightParamSchema,
  parseLatestCountQuery,
  parsePaginationQuery,
  sendInternalError,
  sendValidationError,
} from '../utils/validation';

const router = Router();
const LATEST_BLOCKS_TTL_MS = Math.max(1000, Math.min(10_000, config.cache.ttlSeconds * 1000));
const LATEST_BLOCKS_STALE_MAX_MS = Math.max(LATEST_BLOCKS_TTL_MS * 4, 60_000);
const BLOCK_SUMMARY_TTL_MS = Math.max(1000, Math.min(15_000, config.cache.ttlSeconds * 1000));
const BLOCK_SUMMARY_STALE_MAX_MS = Math.max(BLOCK_SUMMARY_TTL_MS * 4, 90_000);
const BLOCK_TX_PAGE_TTL_MS = Math.max(1000, Math.min(12_000, config.cache.ttlSeconds * 1000));
const BLOCK_TX_PAGE_STALE_MAX_MS = Math.max(BLOCK_TX_PAGE_TTL_MS * 4, 90_000);
const latestBlocksCache = new Map<number, { atMs: number; data: Array<Record<string, unknown>> }>();
const TOTAL_BLOCK_COUNT_TTL_MS = 15_000;
let totalBlockCountCache: { atMs: number; total: number } | null = null;
let totalBlockCountInFlight: Promise<number> | null = null;
const latestBlocksInFlight = new Map<number, Promise<Array<Record<string, unknown>>>>();
const BLOCK_SUMMARY_CACHE_LIMIT = 300;
const BLOCK_TX_PAGE_CACHE_LIMIT = 500;
const blockSummaryCache = new Map<string, { atMs: number; payload: unknown }>();
const blockTxPageCache = new Map<string, { atMs: number; payload: unknown }>();
const blockSummaryInFlight = new Map<string, Promise<{ success: true; data: Record<string, unknown> } | null>>();
const blockTxPageInFlight = new Map<
  string,
  Promise<{
    success: true;
    data: Array<Record<string, unknown>>;
    pagination: { page: number; limit: number; total: number; pages: number };
  }>
>();

function setLruCached(
  store: Map<string, { atMs: number; payload: unknown }>,
  key: string,
  payload: unknown,
  maxSize: number
): void {
  if (store.has(key)) {
    store.delete(key);
  } else if (store.size >= maxSize) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  store.set(key, { atMs: Date.now(), payload });
}

function peekLruCached(
  store: Map<string, { atMs: number; payload: unknown }>,
  key: string
): { atMs: number; payload: unknown } | null {
  return store.get(key) ?? null;
}

function isFresh(cachedAtMs: number, ttlMs: number): boolean {
  return Date.now() - cachedAtMs < ttlMs;
}

async function getTotalBlockCount(): Promise<number> {
  if (totalBlockCountCache && isFresh(totalBlockCountCache.atMs, TOTAL_BLOCK_COUNT_TTL_MS)) {
    return totalBlockCountCache.total;
  }

  if (totalBlockCountInFlight) {
    return totalBlockCountInFlight;
  }

  totalBlockCountInFlight = Block.countDocuments()
    .then((total) => {
      totalBlockCountCache = { atMs: Date.now(), total };
      return total;
    })
    .finally(() => {
      totalBlockCountInFlight = null;
    });

  return totalBlockCountInFlight;
}

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
};

const BLOCK_TX_LIST_PROJECTION = {
  txid: 1,
  blockheight: 1,
  blocktime: 1,
  totalValueInSat: 1,
  totalValueOutSat: 1,
  feeSat: 1,
  size: 1,
  isCoinbase: 1,
  'vout.valueSat': 1,
  'vout.scriptPubKey.addresses': { $slice: 1 },
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
    const cursorHeightRaw = req.query.cursorHeight;
    let cursorHeight: number | null = null;
    if (cursorHeightRaw !== undefined && cursorHeightRaw !== null && String(cursorHeightRaw).trim() !== '') {
      const parsed = Number.parseInt(String(cursorHeightRaw), 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return sendValidationError(res, 'cursorHeight must be a positive integer');
      }
      cursorHeight = parsed;
    }

    const rangeParsed = blocksRangeQuerySchema.safeParse({
      from: req.query.from,
      to: req.query.to,
    });
    if (!rangeParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(rangeParsed.error));
    }
    let from = rangeParsed.data.from ?? null;
    let to = rangeParsed.data.to ?? null;

    if (from != null && to != null && from > to) {
      const tmp = from;
      from = to;
      to = tmp;
    }

    const filter: { time?: { $gte?: number; $lte?: number } } = {};
    if (from != null || to != null) {
      filter.time = {};
      if (from != null) filter.time.$gte = from;
      if (to != null) filter.time.$lte = to;
    }
    const baseFilter = filter as Record<string, unknown>;

    const hasTimeFilter = from != null || to != null;

    if (cursorModeRequested || cursorHeight != null) {
      const cursorFilter: Record<string, unknown> = { ...baseFilter };
      if (cursorHeight != null) {
        cursorFilter.height = { $lt: cursorHeight };
      }

      const [rows, tip] = await Promise.all([
        Block.find(cursorFilter)
          .sort({ height: -1 })
          .limit(limit + 1)
          .select(BLOCK_LIST_PROJECTION)
          .lean(),
        getChainTip(),
      ]);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const bestHeight = tip.height;
      const data = pageRows.map((block) =>
        withBlockConfirmations(normalizeBlockAmounts(block), bestHeight)
      );
      const lastRow = pageRows.length > 0 ? (pageRows[pageRows.length - 1] as { height: number }) : null;
      const nextCursorHeight = hasMore && lastRow ? lastRow.height : null;

      return res.json({
        success: true,
        data,
        cursor: {
          mode: 'cursor',
          hasMore,
          next: nextCursorHeight != null ? { cursorHeight: nextCursorHeight } : null,
        },
        filters: { from, to },
      });
    }

    const [blocks, total, tip] = await Promise.all([
      Block.find(filter).sort({ height: -1 }).skip(skip).limit(limit).select(BLOCK_LIST_PROJECTION).lean(),
      hasTimeFilter ? Block.countDocuments(filter) : getTotalBlockCount(),
      getChainTip(),
    ]);
    const bestHeight = tip.height;
    const data = blocks.map((block) =>
      withBlockConfirmations(normalizeBlockAmounts(block), bestHeight)
    );

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      filters: { from, to },
    });
  } catch (error) {
    sendInternalError(res, 'Failed to fetch blocks', error);
  }
});

router.get('/latest', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const countParsed = parseLatestCountQuery(req.query as Record<string, unknown>, 10);
    if (!countParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(countParsed.error));
    }
    const { count } = countParsed.data;
    const cached = latestBlocksCache.get(count);
    if (cached && isFresh(cached.atMs, LATEST_BLOCKS_TTL_MS)) {
      return res.json({ success: true, data: cached.data });
    }

    const staleFallbackAllowed = !!cached && isFresh(cached.atMs, LATEST_BLOCKS_STALE_MAX_MS);
    const inFlight = latestBlocksInFlight.get(count);
    if (inFlight) {
      try {
        const dedupedData = await inFlight;
        return res.json({ success: true, data: dedupedData });
      } catch {
        if (staleFallbackAllowed && cached) {
          return res.json({ success: true, data: cached.data });
        }
        throw new Error('Latest blocks in-flight query failed');
      }
    }

    const fetchPromise = (async () => {
      const [blocks, tip] = await Promise.all([
        Block.find().sort({ height: -1 }).limit(count).select(BLOCK_LIST_PROJECTION).lean(),
        getChainTip(),
      ]);
      const bestHeight = tip.height;
      const data = blocks.map((block) =>
        withBlockConfirmations(normalizeBlockAmounts(block), bestHeight)
      );
      latestBlocksCache.set(count, { atMs: Date.now(), data });
      return data;
    })();

    latestBlocksInFlight.set(count, fetchPromise);
    try {
      const data = await fetchPromise;
      return res.json({ success: true, data });
    } catch (error) {
      if (staleFallbackAllowed && cached) {
        return res.json({ success: true, data: cached.data });
      }
      throw error;
    } finally {
      if (latestBlocksInFlight.get(count) === fetchPromise) {
        latestBlocksInFlight.delete(count);
      }
    }
  } catch (error) {
    sendInternalError(res, 'Failed to fetch blocks', error);
  }
});

router.get('/:hashOrHeight', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const paramParsed = hashOrHeightParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paramParsed.error));
    }
    const { hashOrHeight } = paramParsed.data;
    const isHeight = /^\d+$/.test(hashOrHeight);
    const normalizedKey = isHeight ? `h:${hashOrHeight}` : `x:${hashOrHeight.toLowerCase()}`;
    const cachedEntry = peekLruCached(blockSummaryCache, normalizedKey);
    const cached =
      cachedEntry && isFresh(cachedEntry.atMs, BLOCK_SUMMARY_TTL_MS)
        ? (cachedEntry.payload as { success: true; data: Record<string, unknown> })
        : null;
    if (cached) {
      return res.json(cached);
    }
    const staleCached =
      cachedEntry && isFresh(cachedEntry.atMs, BLOCK_SUMMARY_STALE_MAX_MS)
        ? (cachedEntry.payload as { success: true; data: Record<string, unknown> })
        : null;
    const staleFallbackAllowed = !!staleCached;
    const inFlight = blockSummaryInFlight.get(normalizedKey);
    if (inFlight) {
      try {
        const dedupedPayload = await inFlight;
        if (!dedupedPayload) {
          return res
            .status(404)
            .json({ success: false, error: { code: 'NOT_FOUND', message: 'Block not found' } });
        }
        return res.json(dedupedPayload);
      } catch {
        if (staleFallbackAllowed && staleCached) {
          return res.json(staleCached);
        }
        throw new Error('Block summary in-flight query failed');
      }
    }

    const fetchPromise = (async () => {
      const query = isHeight ? { height: parseInt(hashOrHeight, 10) } : { hash: hashOrHeight };
      const [block, tip] = await Promise.all([
        Block.findOne(query).lean<Record<string, unknown> & { height: number }>(),
        getChainTip(),
      ]);

      if (!block) {
        return null;
      }

      const bestHeight = tip.height;
      // Who staked (or mined) the block and which masternode it paid; null where the chain data
      // does not show it. `minedBy` stays as stored: the first address the coinbase pays.
      const roles = await loadBlockRoles(block.txids);
      const payload = {
        success: true as const,
        data: { ...withBlockConfirmations(normalizeBlockAmounts(block), bestHeight), ...roles },
      };
      setLruCached(blockSummaryCache, normalizedKey, payload, BLOCK_SUMMARY_CACHE_LIMIT);
      return payload;
    })();

    blockSummaryInFlight.set(normalizedKey, fetchPromise);
    try {
      const payload = await fetchPromise;
      if (!payload) {
        return res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Block not found' } });
      }
      return res.json(payload);
    } catch (error) {
      if (staleFallbackAllowed && staleCached) {
        return res.json(staleCached);
      }
      throw error;
    } finally {
      if (blockSummaryInFlight.get(normalizedKey) === fetchPromise) {
        blockSummaryInFlight.delete(normalizedKey);
      }
    }
  } catch (error) {
    sendInternalError(res, 'Failed to fetch block', error);
  }
});

router.get('/:hashOrHeight/txs', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const paramParsed = hashOrHeightParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paramParsed.error));
    }
    const { hashOrHeight } = paramParsed.data;

    const paginationParsed = parsePaginationQuery(req.query as Record<string, unknown>, {
      page: 1,
      limit: 20,
    });
    if (!paginationParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paginationParsed.error));
    }
    const { page, limit } = paginationParsed.data;
    const skip = (page - 1) * limit;

    const isHeight = /^\d+$/.test(hashOrHeight);
    const cacheKey = `${isHeight ? 'h' : 'x'}:${hashOrHeight.toLowerCase()}:${page}:${limit}`;
    const cachedEntry = peekLruCached(blockTxPageCache, cacheKey);
    const cached =
      cachedEntry && isFresh(cachedEntry.atMs, BLOCK_TX_PAGE_TTL_MS)
        ? (cachedEntry.payload as {
            success: true;
            data: Array<Record<string, unknown>>;
            pagination: { page: number; limit: number; total: number; pages: number };
          })
        : null;
    if (cached) {
      return res.json(cached);
    }
    const staleCached =
      cachedEntry && isFresh(cachedEntry.atMs, BLOCK_TX_PAGE_STALE_MAX_MS)
        ? (cachedEntry.payload as {
            success: true;
            data: Array<Record<string, unknown>>;
            pagination: { page: number; limit: number; total: number; pages: number };
          })
        : null;
    const staleFallbackAllowed = !!staleCached;
    const inFlight = blockTxPageInFlight.get(cacheKey);
    if (inFlight) {
      try {
        const dedupedPayload = await inFlight;
        return res.json(dedupedPayload);
      } catch {
        if (staleFallbackAllowed && staleCached) {
          return res.json(staleCached);
        }
        throw new Error('Block tx page in-flight query failed');
      }
    }

    const fetchPromise = (async () => {
      const query = isHeight ? { blockheight: parseInt(hashOrHeight, 10) } : { blockhash: hashOrHeight };

      const [txs, blockDoc, tip] = await Promise.all([
        Transaction.find(query).sort({ _id: 1 }).skip(skip).limit(limit).select(BLOCK_TX_LIST_PROJECTION).lean(),
        Block.findOne(isHeight ? { height: parseInt(hashOrHeight, 10) } : { hash: hashOrHeight })
          .select({ nTx: 1 })
          .lean<{ nTx?: number }>(),
        getChainTip(),
      ]);
      const total = blockDoc?.nTx ?? 0;
      const bestHeight = tip.height;
      const data = txs.map((tx) =>
        withTxConfirmations(normalizeTransactionAmounts(tx, { maxVoutAddresses: 1 }), bestHeight)
      );

      const payload = {
        success: true as const,
        data,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
      setLruCached(blockTxPageCache, cacheKey, payload, BLOCK_TX_PAGE_CACHE_LIMIT);
      return payload;
    })();

    blockTxPageInFlight.set(cacheKey, fetchPromise);
    try {
      const payload = await fetchPromise;
      return res.json(payload);
    } catch (error) {
      if (staleFallbackAllowed && staleCached) {
        return res.json(staleCached);
      }
      throw error;
    } finally {
      if (blockTxPageInFlight.get(cacheKey) === fetchPromise) {
        blockTxPageInFlight.delete(cacheKey);
      }
    }
  } catch (error) {
    sendInternalError(res, 'Failed to fetch transactions', error);
  }
});

export default router;
