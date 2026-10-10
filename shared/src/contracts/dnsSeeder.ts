import { z } from 'zod';

const timestamp = z.string().datetime();
const count = z.number().int().nonnegative();
const versionSource = z.enum(['dns-seeder', 'explorer-daemon']).nullable();

export const dnsSeederNodeSchema = z.object({
  ip: z.string().ip(),
  port: z.number().int().min(1).max(65535),
  blockHeight: count.nullable(),
  snapshotBlockHeight: count.nullable(),
  // Crawler hash, never paired with a direct peer's height for chain comparison.
  bestBlockHash: z.string().regex(/^[0-9a-f]{64}$/i).nullable(),
  isLivePeer: z.boolean(),
  livePeerObservedAt: timestamp.nullable(),
  uptime2h: z.number().min(0).max(100).nullable(),
  lastSeen: timestamp.nullable(),
  walletVersion: z.string().nullable(),
  walletVersionSource: versionSource,
  protocolVersion: count.nullable(),
  protocolVersionSource: versionSource,
  peerCount: count.nullable(),
});

export const dnsSeederNodesApiResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(dnsSeederNodeSchema),
  meta: z.object({
    generatedAt: timestamp,
    dnsSeeder: z.object({
      status: z.enum(['ok', 'stale', 'disabled']),
      fetchedAt: timestamp.nullable(),
      lastAttemptAt: timestamp.nullable(),
      // Retrieval time does not establish the crawler snapshot's age or coverage.
      sourceObservedAt: z.null(),
      completeness: z.literal('unknown'),
      receivedRows: count,
      rejectedRows: count,
      duplicateRows: count,
      omittedRows: count,
      returnedRows: count,
      limit: z.number().int().positive(),
    }),
    daemonPeers: z.object({
      status: z.enum(['ok', 'unavailable', 'not-requested']),
      observedAt: timestamp.nullable(),
    }),
    // Neither last-seen age nor absence from getpeerinfo identifies a port error.
    portFailureEvidence: z.literal('unavailable'),
  }),
}).superRefine(({ data, meta }, ctx) => {
  const feed = meta.dnsSeeder;
  if (feed.returnedRows !== data.length || feed.returnedRows > feed.limit
    || feed.receivedRows !== feed.returnedRows + feed.rejectedRows + feed.duplicateRows + feed.omittedRows) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent feed coverage' });
  }
  if (feed.status === 'disabled' ? feed.fetchedAt !== null || data.length > 0 : feed.fetchedAt === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Missing or inconsistent feed observation' });
  }
  if ((meta.daemonPeers.status === 'ok') !== (meta.daemonPeers.observedAt !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent peer observation' });
  }
  const endpoints = new Set<string>();
  data.forEach((node, index) => {
    const key = `${node.ip}:${node.port}`;
    if (endpoints.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['data', index], message: 'Duplicate endpoint' });
    endpoints.add(key);
    if (node.isLivePeer
      ? meta.daemonPeers.status !== 'ok' || node.livePeerObservedAt !== meta.daemonPeers.observedAt
      : node.livePeerObservedAt !== null || node.blockHeight !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['data', index], message: 'Unproven direct peer' });
    }
  });
});

export type DnsSeederNodeContract = z.infer<typeof dnsSeederNodeSchema>;
export type DnsSeederNodesApiResponse = z.infer<typeof dnsSeederNodesApiResponseSchema>;
