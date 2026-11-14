import { Router, Request, Response } from 'express';
import { Block } from '../models/Block';
import { Transaction } from '../models/Transaction';
import { Address } from '../models/Address';
import { COIN } from '@defcon/shared';
import { searchApiResponseSchema, type SearchApiResponse } from '@defcon/shared/dist/contracts';
import { config } from '../config';
import { withCachePolicy } from '../middleware/cachePolicy';
import {
  firstValidationIssueMessage,
  searchQuerySchema,
  sendInternalError,
  sendValidationError,
} from '../utils/validation';

const router = Router();

// Base58 character set (no 0, O, I, l)
const BASE58_RE = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
const HEX64_RE = /^[a-fA-F0-9]{64}$/;
const NUMERIC_RE = /^\d+$/;

const SEARCH_CACHE_TTL_MS = Math.max(1000, Math.min(15_000, config.cache.ttlSeconds * 1000));
const SEARCH_STALE_MAX_MS = Math.max(SEARCH_CACHE_TTL_MS * 4, 60_000);
const SEARCH_CACHE_LIMIT = 256;

type SearchPayload = SearchApiResponse | null;

const searchCache = new Map<string, { atMs: number; payload: SearchPayload }>();
const searchInFlight = new Map<string, Promise<SearchPayload>>();

function isFresh(cachedAtMs: number, ttlMs: number): boolean {
  return Date.now() - cachedAtMs < ttlMs;
}

function isValidAddressFormat(q: string): boolean {
  return (
    q.length >= 26 &&
    q.length <= 35 &&
    q.startsWith(COIN.ADDRESS_PREFIX) &&
    BASE58_RE.test(q)
  );
}

function getSearchCache(key: string): SearchPayload | undefined {
  const entry = searchCache.get(key);
  if (!entry) return undefined;
  if (!isFresh(entry.atMs, SEARCH_CACHE_TTL_MS)) {
    // Retain until the longer stale deadline so a failed refresh can fall back.
    return undefined;
  }
  // LRU touch
  searchCache.delete(key);
  searchCache.set(key, entry);
  return entry.payload;
}

function getSearchStaleCache(key: string): SearchPayload | undefined {
  const entry = searchCache.get(key);
  if (!entry) return undefined;
  if (!isFresh(entry.atMs, SEARCH_STALE_MAX_MS)) {
    searchCache.delete(key);
    return undefined;
  }
  return entry.payload;
}

function setSearchCache(key: string, payload: SearchPayload): void {
  if (searchCache.has(key)) searchCache.delete(key);
  while (searchCache.size >= SEARCH_CACHE_LIMIT) {
    const oldest = searchCache.keys().next().value;
    if (!oldest) break;
    searchCache.delete(oldest);
  }
  searchCache.set(key, { atMs: Date.now(), payload });
}

function createSearchPayload(data: unknown): SearchApiResponse {
  return searchApiResponseSchema.parse({ success: true, data });
}

async function performSearch(q: string): Promise<SearchPayload> {
  // Block height (numeric only)
  if (NUMERIC_RE.test(q)) {
    const height = parseInt(q, 10);
    if (height >= 0 && height <= 100_000_000) {
      const block = await Block.findOne({ height }).select({ height: 1, hash: 1 }).lean();
      if (block) {
        return createSearchPayload({ type: 'block', matchedBy: 'height', result: block });
      }
    }
  }

  // Block hash or txid (strict 64-char hex) - query both in parallel
  if (HEX64_RE.test(q)) {
    const [block, tx] = await Promise.all([
      Block.findOne({ hash: q }).select({ height: 1, hash: 1 }).lean(),
      Transaction.findOne({ txid: q }).select({ txid: 1 }).lean(),
    ]);
    if (block) {
      return createSearchPayload({ type: 'block', matchedBy: 'hash', result: block });
    }
    if (tx) {
      return createSearchPayload({ type: 'transaction', matchedBy: 'txid', result: tx });
    }
  }

  // Address (valid Base58 format with correct prefix only)
  if (isValidAddressFormat(q)) {
    const address = await Address.findOne({ address: q }).select({ address: 1 }).lean();
    if (address) {
      return createSearchPayload({ type: 'address', matchedBy: 'address', result: address });
    }
  }

  return null;
}

router.get('/', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const queryParsed = searchQuerySchema.safeParse({ q: req.query.q });
    if (!queryParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(queryParsed.error));
    }
    // Hashes are stored in lower case, so one typed in capitals is lowered before the lookup and
    // the cache key. Anything else keeps its case: an address is base58, where case is part of it.
    const typed = queryParsed.data.q;
    const q = HEX64_RE.test(typed) ? typed.toLowerCase() : typed;
    const cacheKey = q;

    const cached = getSearchCache(cacheKey);
    if (cached !== undefined) {
      if (cached) return res.json(cached);
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No results found' } });
    }
    const staleCached = getSearchStaleCache(cacheKey);

    const inFlight = searchInFlight.get(cacheKey);
    if (inFlight) {
      try {
        const payload = await inFlight;
        if (payload) return res.json(payload);
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No results found' } });
      } catch {
        if (staleCached !== undefined) {
          if (staleCached) return res.json(staleCached);
          return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No results found' } });
        }
        throw new Error('search in-flight query failed');
      }
    }

    const fetchPromise = performSearch(q);
    searchInFlight.set(cacheKey, fetchPromise);
    try {
      const payload = await fetchPromise;
      setSearchCache(cacheKey, payload);
      if (payload) return res.json(payload);
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No results found' } });
    } catch (error) {
      if (staleCached !== undefined) {
        if (staleCached) return res.json(staleCached);
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No results found' } });
      }
      throw error;
    } finally {
      if (searchInFlight.get(cacheKey) === fetchPromise) {
        searchInFlight.delete(cacheKey);
      }
    }
  } catch (error) {
    sendInternalError(res, 'Search failed', error);
  }
});

export default router;
