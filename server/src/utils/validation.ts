import type { Response } from 'express';
import { z } from 'zod';
import { COIN } from '@defcon/shared';
import { logger } from './logger';

// Base58 character set (no 0, O, I, l)
const BASE58_REGEX = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

const optionalQueryInt = (min: number, max: number) =>
  z.preprocess(
    (value) => (value === undefined || value === null || value === '' ? undefined : value),
    z.coerce.number().int().min(min).max(max).optional()
  );

// Hashes are stored in lower case. A hash typed in capitals is the same hash, so it is lowered
// here, once, before any cache key or database query sees it.
const toLowerCase = (value: string) => value.toLowerCase();

export const txidParamSchema = z.object({
  txid: z.string().trim().regex(/^[a-fA-F0-9]{64}$/, 'Invalid txid format').transform(toLowerCase),
});

export const addressParamSchema = z.object({
  address: z
    .string()
    .trim()
    .min(26, 'Address is too short')
    .max(35, 'Address is too long')
    .refine((addr) => addr.startsWith(COIN.ADDRESS_PREFIX), 'Invalid address prefix')
    .refine((addr) => BASE58_REGEX.test(addr), 'Invalid address characters'),
});

export const hashOrHeightParamSchema = z.object({
  hashOrHeight: z
    .string()
    .trim()
    .regex(/^(\d+|[a-fA-F0-9]{64})$/, 'Value must be a block height or 64-char hash')
    .transform(toLowerCase),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Query required').max(128, 'Query too long'),
});

export const blocksRangeQuerySchema = z.object({
  from: optionalQueryInt(0, 4_102_444_800),
  to: optionalQueryInt(0, 4_102_444_800),
});

const paginationQueryBaseSchema = z.object({
  page: optionalQueryInt(1, 1_000_000),
  limit: optionalQueryInt(1, 100),
});

const latestCountBaseSchema = z.object({
  count: optionalQueryInt(1, 100),
});

const mempoolLimitBaseSchema = z.object({
  limit: optionalQueryInt(1, 30),
});

const marketDaysBaseSchema = z.object({
  days: optionalQueryInt(1, 365),
});

export function parsePaginationQuery(
  query: Record<string, unknown>,
  defaults: { page: number; limit: number }
) {
  const parsed = paginationQueryBaseSchema.safeParse({
    page: query.page,
    limit: query.limit,
  });

  if (!parsed.success) return parsed;

  return {
    success: true as const,
    data: {
      page: parsed.data.page ?? defaults.page,
      limit: parsed.data.limit ?? defaults.limit,
    },
  };
}

export function parseLatestCountQuery(
  query: Record<string, unknown>,
  defaultCount: number
) {
  const parsed = latestCountBaseSchema.safeParse({ count: query.count });
  if (!parsed.success) return parsed;

  return {
    success: true as const,
    data: { count: parsed.data.count ?? defaultCount },
  };
}

export function parseMempoolLimitQuery(
  query: Record<string, unknown>,
  defaultLimit: number
) {
  const parsed = mempoolLimitBaseSchema.safeParse({ limit: query.limit });
  if (!parsed.success) return parsed;

  return {
    success: true as const,
    data: { limit: parsed.data.limit ?? defaultLimit },
  };
}

export function parseMarketDaysQuery(
  query: Record<string, unknown>,
  defaultDays: number
) {
  const parsed = marketDaysBaseSchema.safeParse({ days: query.days });
  if (!parsed.success) return parsed;

  return {
    success: true as const,
    data: { days: parsed.data.days ?? defaultDays },
  };
}

export function sendValidationError(res: Response, message: string) {
  return res.status(400).json({
    success: false,
    error: { code: 'BAD_REQUEST', message },
  });
}

let errorCounter = 0;

function nextErrorId(): string {
  return `E-${Date.now()}-${++errorCounter}`;
}

export function sendInternalError(res: Response, message: string, error?: unknown) {
  const errorId = nextErrorId();
  logger.error(`[${errorId}] ${message}:`, error);
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL', message, errorId },
  });
}

export function sendServiceUnavailable(res: Response, message: string, error?: unknown) {
  const errorId = nextErrorId();
  logger.error(`[${errorId}] ${message}:`, error);
  return res.status(503).json({
    success: false,
    error: { code: 'SERVICE_UNAVAILABLE', message, errorId },
  });
}

export function firstValidationIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message || 'Invalid request';
}

// --- v1 API schemas ---

export const masternodeIdParamSchema = z.object({
  id: z.string().trim().min(1, 'Masternode ID is required').max(128, 'ID too long'),
});

const v1LatestCountBaseSchema = z.object({
  count: optionalQueryInt(1, 100),
});

export function parseV1LatestCount(
  query: Record<string, unknown>,
  defaultCount: number
) {
  const parsed = v1LatestCountBaseSchema.safeParse({ count: query.count });
  if (!parsed.success) return parsed;

  return {
    success: true as const,
    data: { count: parsed.data.count ?? defaultCount },
  };
}

const v1EventsLimitBaseSchema = z.object({
  limit: optionalQueryInt(1, 500),
});

export function parseV1EventsLimit(
  query: Record<string, unknown>,
  defaultLimit: number
) {
  const parsed = v1EventsLimitBaseSchema.safeParse({ limit: query.limit });
  if (!parsed.success) return parsed;

  return {
    success: true as const,
    data: { limit: parsed.data.limit ?? defaultLimit },
  };
}
