import { Router, Request, Response } from 'express';
import { isIP } from 'node:net';
import axios from 'axios';
import { rpcService } from '../services/rpc.service';
import { dnsSeederNodesService } from '../services/dnsSeederNodes.service';
import { networkHealthService } from '../services/networkHealth.service';
import { seedNodeService } from '../services/seedNode.service';
import { realtimeService } from '../services/realtime.service';
import { SyncState } from '../models/SyncState';
import { config } from '../config';
import { logger } from '../utils/logger';
import { lookupCountryCode } from '../utils/geoip';
import { withCachePolicy } from '../middleware/cachePolicy';
import { sendServiceUnavailable } from '../utils/validation';
import { mapPublicSyncError } from '../utils/publicSyncError';

const router = Router();
const GEO_CACHE_LIMIT = 2048;
const NETWORK_TTL_MS = Math.max(1000, Math.min(10_000, config.cache.ttlSeconds * 1000));
const OPS_STATUS_TTL_MS = Math.max(1000, Math.min(8_000, config.cache.ttlSeconds * 1000));
const NETWORK_STALE_MAX_AGE_MS = 2 * 60_000;
const OPS_STATUS_STALE_MAX_AGE_MS = 2 * 60_000;
const PRE_RELEASE_NODES_TIMEOUT_MS = config.nodeInventory.requestTimeoutMs;
const PRE_RELEASE_NODES_FAILURE_BACKOFF_MS = config.nodeInventory.failureBackoffMs;
const PRE_RELEASE_NODES_STALE_MAX_AGE_MS = config.nodeInventory.staleMaxAgeMs;
// These monitored full nodes are also compiled into the Core static fallback
// seed set. Keep the Explorer marker aligned with src/chainparamsseeds.h.
const CORE_STATIC_FALLBACK_SEED_IPS = new Set(['178.18.247.92', '178.18.252.84', '194.163.130.132']);
const geoCache = new Map<string, { countryCode: string; countryName: string }>();
let networkCache:
  | {
      atMs: number;
      payload: {
        success: true;
        data: {
          connections: number;
          protocolversion: number;
          subversion: string;
          blockHeight: number | null;
          headerHeight: number | null;
          peers: Array<Record<string, unknown>>;
        };
      };
    }
  | null = null;
let networkInFlight:
  | Promise<{
      success: true;
      data: {
        connections: number;
        protocolversion: number;
        subversion: string;
        blockHeight: number | null;
        headerHeight: number | null;
        peers: Array<Record<string, unknown>>;
      };
    }>
  | null = null;

// Exported for route-level tests and future explicit invalidation after a daemon reconnect.
export function invalidateNetworkCache(): void {
  networkCache = null;
  networkInFlight = null;
}

let preReleaseNodesCache:
  | {
      atMs: number;
      payload: {
        success: true;
        data: Array<{
          ip: string;
          port: number;
          blockHeight: number | null;
          bestBlockHash: string | null;
          peerCount: number | null;
          walletVersion: string | null;
          protocolVersion: number | null;
          syncProgress: number | null;
          status: string | null;
          checkedAt: string | null;
          nodeLabel: string | null;
          isCanonicalFallbackSeed: boolean;
        }>;
      };
    }
  | null = null;
let preReleaseNodesInFlight:
  | Promise<{
      success: true;
      data: Array<{
        ip: string;
        port: number;
        blockHeight: number | null;
        bestBlockHash: string | null;
        peerCount: number | null;
        walletVersion: string | null;
        protocolVersion: number | null;
        syncProgress: number | null;
        status: string | null;
        checkedAt: string | null;
        nodeLabel: string | null;
        isCanonicalFallbackSeed: boolean;
      }>;
    }>
  | null = null;
let preReleaseNodesLastFailureAtMs = 0;
let opsStatusCache: { atMs: number; payload: { success: true; data: Record<string, unknown> } } | null = null;
let opsStatusInFlight: Promise<{ success: true; data: Record<string, unknown> }> | null = null;
type RpcNetworkInfo = {
  connections?: number;
  protocolversion?: number;
  subversion?: string;
  version?: number;
};

type RpcPeerInfo = {
  addr?: string;
  version?: number;
  subver?: string;
  inbound?: boolean;
  startingheight?: number;
  synced_headers?: number;
  synced_blocks?: number;
  conntime?: number;
  pingtime?: number;
};

type RpcBlockchainInfo = {
  blocks?: number;
  headers?: number;
  verificationprogress?: number;
  bestblockhash?: string;
};

type RpcBestChainLock = {
  blockhash?: string;
  height?: number;
};

const countryNames =
  typeof Intl !== 'undefined' && typeof Intl.DisplayNames !== 'undefined'
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

function getCountryName(countryCode: string): string {
  if (countryCode === 'TOR') return 'Tor';
  if (!countryCode || countryCode === 'XX') return 'Unknown';
  if (!countryNames) return countryCode;
  return countryNames.of(countryCode) || countryCode;
}

function normalizeIp(host: string): string {
  if (host.startsWith('::ffff:')) return host.slice(7);
  return host;
}

function parsePeerAddress(addrRaw: unknown): { host: string; isIpv6: boolean; isTor: boolean } {
  const addr = String(addrRaw || '').trim();
  if (!addr) return { host: '', isIpv6: false, isTor: false };

  const lowered = addr.toLowerCase();
  if (lowered.endsWith('.onion') || lowered.includes('.onion:')) {
    return { host: addr.split(':')[0], isIpv6: false, isTor: true };
  }

  const ipv6Match = addr.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (ipv6Match) {
    const host = normalizeIp(ipv6Match[1]);
    return { host, isIpv6: isIP(host) === 6, isTor: false };
  }

  const lastColon = addr.lastIndexOf(':');
  const maybeHost = lastColon > -1 && addr.indexOf(':') === lastColon ? addr.slice(0, lastColon) : addr;
  const host = normalizeIp(maybeHost);
  const ipVersion = isIP(host);

  return { host, isIpv6: ipVersion === 6, isTor: false };
}

function parseNonNegativeInt(raw: unknown): number | null {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeBlockHash(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  return /^[0-9a-f]{64}$/i.test(value) ? value : null;
}

function normalizeWalletVersionLabel(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  return (
    value
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/^DeFCoN:/i, '')
      .replace(/^Dash Core:/i, '')
      .trim() || null
  );
}

function normalizeIsoTimestamp(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) {
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const epochMs = raw > 1_000_000_000_000 ? raw : raw * 1000;
    const date = new Date(epochMs);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function getGeoCache(host: string): { countryCode: string; countryName: string } | null {
  const value = geoCache.get(host);
  if (!value) return null;
  geoCache.delete(host);
  geoCache.set(host, value);
  return value;
}

function setGeoCache(host: string, value: { countryCode: string; countryName: string }): void {
  if (geoCache.has(host)) {
    geoCache.delete(host);
  } else if (geoCache.size >= GEO_CACHE_LIMIT) {
    for (const key of geoCache.keys()) {
      geoCache.delete(key);
      break;
    }
  }
  geoCache.set(host, value);
}

function resolveCountry(host: string, isTor: boolean): { countryCode: string; countryName: string } {
  if (isTor) return { countryCode: 'TOR', countryName: getCountryName('TOR') };
  if (!host || isIP(host) === 0) return { countryCode: 'XX', countryName: getCountryName('XX') };

  const cached = getGeoCache(host);
  if (cached) return cached;

  const countryCode = lookupCountryCode(host) || 'XX';
  const resolved = { countryCode, countryName: getCountryName(countryCode) };
  setGeoCache(host, resolved);

  return resolved;
}

// GET /api/network - Network info + peers
router.get('/', withCachePolicy('short'), async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (networkCache && now - networkCache.atMs < NETWORK_TTL_MS) {
      return res.json(networkCache.payload);
    }

    if (!networkInFlight) {
      networkInFlight = (async () => {
        const [networkInfo, peerInfo, blockchainInfo] = await Promise.all([
          rpcService.getNetworkInfo() as Promise<RpcNetworkInfo>,
          rpcService.getPeerInfo() as Promise<RpcPeerInfo[]>,
          // A transient failure here must not make peer sync appear unavailable.
          (rpcService.getBlockchainInfo() as Promise<RpcBlockchainInfo>).catch(() => null),
        ]);

        let blockHeight = parseNonNegativeInt(blockchainInfo?.blocks);
        let headerHeight = parseNonNegativeInt(blockchainInfo?.headers);

        // getblockcount is a lightweight fallback for daemons that temporarily
        // reject getblockchaininfo while still serving normal peer RPC calls.
        if (blockHeight === null) {
          try {
            blockHeight = parseNonNegativeInt(await rpcService.getBlockCount());
          } catch {
            // Preserve the peer payload, but leave sync comparison unavailable.
          }
        }
        headerHeight ??= blockHeight;

        const peers = (peerInfo || []).map((peer) => {
          const addr = peer.addr || '';
          const parsed = parsePeerAddress(addr);
          const country = resolveCountry(parsed.host, parsed.isTor);

          return {
            addr,
            version: peer.version,
            subver: peer.subver,
            inbound: peer.inbound,
            startingheight: peer.startingheight,
            synced_headers: peer.synced_headers,
            synced_blocks: peer.synced_blocks,
            conntime: peer.conntime,
            pingtime: peer.pingtime,
            countryCode: country.countryCode,
            countryName: country.countryName,
            isIpv6: parsed.isIpv6,
          };
        });

        return {
          success: true as const,
          data: {
            connections: networkInfo?.connections ?? 0,
            protocolversion: networkInfo?.protocolversion ?? 0,
            subversion: networkInfo?.subversion ?? '',
            blockHeight,
            headerHeight,
            peers,
          },
        };
      })();
    }

    const activeInFlight = networkInFlight;
    try {
      const payload = await activeInFlight;
      // Never retain an incomplete sync baseline. The next request can recover
      // immediately once the daemon RPC is responsive again.
      if (payload.data.blockHeight !== null || payload.data.headerHeight !== null) {
        networkCache = { atMs: Date.now(), payload };
      }
      return res.json(payload);
    } finally {
      if (networkInFlight === activeInFlight) {
        networkInFlight = null;
      }
    }
  } catch (error) {
    if (networkCache && Date.now() - networkCache.atMs < NETWORK_STALE_MAX_AGE_MS) {
      return res.json(networkCache.payload);
    }
    logger.debug('Could not fetch network info:', error);
    return sendServiceUnavailable(res, 'Could not fetch network info from daemon RPC', error);
  }
});

// GET /api/network/chain-health - Chain fork / sync health from local daemon
router.get('/chain-health', withCachePolicy('short'), (_req: Request, res: Response) => {
  const report = networkHealthService.getReport();
  if (!report) {
    return res.status(503).json({ success: false, error: 'Network health data not yet available' });
  }
  return res.json({ success: true, data: report });
});

// GET /api/network/ops-status - Operator-focused connectivity snapshot
router.get('/ops-status', withCachePolicy('short'), async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (opsStatusCache && now - opsStatusCache.atMs < OPS_STATUS_TTL_MS) {
      return res.json(opsStatusCache.payload);
    }

    if (opsStatusInFlight) {
      const payload = await opsStatusInFlight;
      return res.json(payload);
    }

    opsStatusInFlight = (async () => {
      const warnings: string[] = [];

    const [rpcAlive, networkInfo, blockchainInfo, bestChainLock, syncState] = await Promise.allSettled([
      rpcService.testConnection(),
      rpcService.getNetworkInfo() as Promise<RpcNetworkInfo>,
      rpcService.getBlockchainInfo() as Promise<RpcBlockchainInfo>,
      rpcService.call<RpcBestChainLock>('getbestchainlock'),
      SyncState.findOne({ key: 'main' }).lean(),
    ]);

    const rpcReachable = rpcAlive.status === 'fulfilled' ? rpcAlive.value : false;
    if (!rpcReachable) {
      warnings.push('rpc_unreachable');
    }

    const network = networkInfo.status === 'fulfilled' ? networkInfo.value : null;
    if (networkInfo.status !== 'fulfilled') {
      warnings.push('network_info_unavailable');
    }

    const chain = blockchainInfo.status === 'fulfilled' ? blockchainInfo.value : null;
    if (blockchainInfo.status !== 'fulfilled') {
      warnings.push('blockchain_info_unavailable');
    }

    const chainLock = bestChainLock.status === 'fulfilled' ? bestChainLock.value : null;
    if (bestChainLock.status !== 'fulfilled') {
      warnings.push('chainlock_unavailable');
    }

    const sync = syncState.status === 'fulfilled' ? syncState.value : null;
    if (syncState.status !== 'fulfilled') {
      warnings.push('sync_state_unavailable');
    }

    const daemonHeight = typeof chain?.blocks === 'number' ? chain.blocks : -1;
    const syncedHeight = typeof sync?.lastSyncedHeight === 'number' ? sync.lastSyncedHeight : -1;
    const blocksRemaining = daemonHeight >= 0 && syncedHeight >= 0 ? Math.max(0, daemonHeight - syncedHeight) : null;
    const progress =
      daemonHeight > 0 && syncedHeight >= 0
        ? Math.round(Math.max(0, Math.min(100, ((syncedHeight + 1) / (daemonHeight + 1)) * 100)) * 100) / 100
        : null;

      const data = {
        checkedAt: Date.now(),
        api: {
          status: 'up' as const,
          env: config.nodeEnv,
        },
        client: {
          transport: realtimeService.getConnectionStats(),
        },
        node: {
          rpcReachable,
          daemonVersion: typeof network?.version === 'number' ? network.version : null,
          peerConnections: typeof network?.connections === 'number' ? network.connections : null,
          chainBlocks: typeof chain?.blocks === 'number' ? chain.blocks : null,
          chainHeaders: typeof chain?.headers === 'number' ? chain.headers : null,
          verificationProgress:
            typeof chain?.verificationprogress === 'number'
              ? Math.round(chain.verificationprogress * 10000) / 10000
              : null,
          bestChainLock: {
            height: typeof chainLock?.height === 'number' ? chainLock.height : null,
            hash: typeof chainLock?.blockhash === 'string' ? chainLock.blockhash : null,
          },
        },
        sync: {
          isRunning: Boolean(sync?.isRunning),
          lastSyncedHeight: syncedHeight >= 0 ? syncedHeight : null,
          daemonHeight: daemonHeight >= 0 ? daemonHeight : null,
          blocksRemaining,
          progress,
          error: mapPublicSyncError(sync?.error, rpcReachable).error,
        },
        warnings,
      };

      return { success: true as const, data };
    })();

    const activeInFlight = opsStatusInFlight;
    try {
      const payload = await activeInFlight;
      opsStatusCache = { atMs: Date.now(), payload };
      return res.json(payload);
    } finally {
      if (opsStatusInFlight === activeInFlight) {
        opsStatusInFlight = null;
      }
    }
  } catch (error) {
    if (opsStatusCache && Date.now() - opsStatusCache.atMs < OPS_STATUS_STALE_MAX_AGE_MS) {
      return res.json(opsStatusCache.payload);
    }
    return sendServiceUnavailable(res, 'Could not build ops status snapshot', error);
  }
});

// GET /api/network/seed-nodes - Hardcoded seed node status
router.get('/seed-nodes', withCachePolicy('no-store'), (_req: Request, res: Response) => {
  return res.json({ success: true, data: seedNodeService.getReport() });
});

// GET /api/network/dns-seeder-nodes - Existing feed and exact outbound peer observations.
router.get('/dns-seeder-nodes', withCachePolicy('no-store'), async (_req: Request, res: Response) => {
  try {
    return res.json(await dnsSeederNodesService.getSnapshot());
  } catch (error) {
    return sendServiceUnavailable(res, 'Could not fetch DNS seeder nodes', error);
  }
});

// GET /api/network/pre-release-nodes - External snapshot of monitored test nodes (normalized)
router.get('/pre-release-nodes', withCachePolicy('no-store'), async (_req: Request, res: Response) => {
  const { preReleaseNodesApiUrl: feedUrl, preReleaseNodesApiKey: feedApiKey } = config.nodeInventory;
  // An unset PRE_RELEASE_NODES_API_URL disables the feed: answer with an
  // empty snapshot, without an upstream request or a log entry.
  if (!feedUrl) {
    return res.json({ success: true, data: [] });
  }

  try {
    const now = Date.now();
    if (preReleaseNodesCache && now - preReleaseNodesCache.atMs < NETWORK_TTL_MS) {
      return res.json(preReleaseNodesCache.payload);
    }
    const inBackoffWindow =
      preReleaseNodesLastFailureAtMs > 0 &&
      now - preReleaseNodesLastFailureAtMs < PRE_RELEASE_NODES_FAILURE_BACKOFF_MS;
    const canServeStale =
      preReleaseNodesCache != null &&
      now - preReleaseNodesCache.atMs < PRE_RELEASE_NODES_STALE_MAX_AGE_MS;
    if (inBackoffWindow && canServeStale && preReleaseNodesCache) {
      return res.json(preReleaseNodesCache.payload);
    }

    if (!preReleaseNodesInFlight) {
      preReleaseNodesInFlight = (async () => {
        const response = await axios.get(feedUrl, {
          timeout: PRE_RELEASE_NODES_TIMEOUT_MS,
          headers: feedApiKey ? { 'X-API-Key': feedApiKey } : undefined,
        });
        const rowsRaw: unknown = response?.data;
        const rows = Array.isArray(rowsRaw)
          ? rowsRaw
          : Array.isArray((rowsRaw as { data?: unknown[] })?.data)
            ? ((rowsRaw as { data?: unknown[] }).data as unknown[])
            : Array.isArray((rowsRaw as { nodes?: unknown[] })?.nodes)
              ? ((rowsRaw as { nodes?: unknown[] }).nodes as unknown[])
              : [];

        const normalized = rows
          .map((item) => {
            const row = item as Record<string, unknown>;
            const ip = String(row.ip || '').trim();
            const port = parseNonNegativeInt(row.port) ?? 8192;
            const blockHeight = parseNonNegativeInt(row.block_height ?? row.blockHeight ?? row.height);
            const bestBlockHash = normalizeBlockHash(
              row.best_hash ??
                row.bestHash ??
                row.best_block_hash ??
                row.bestBlockHash ??
                row.hash ??
                null
            );
            const peerCount = parseNonNegativeInt(row.connections ?? row.peer_count ?? row.peerCount ?? row.peers);
            const walletVersion = normalizeWalletVersionLabel(
              row.version ??
                row.wallet_version ??
                row.walletVersion ??
                row.subver ??
                row.user_agent ??
                row.userAgent
            );
            const protocolVersion = parseNonNegativeInt(
              row.protocol_version ?? row.protocolVersion ?? row.protocol ?? row.proto
            );
            const syncProgressRaw = Number.parseFloat(String(row.sync_progress ?? row.syncProgress ?? '').replace('%', ''));
            const syncProgress = Number.isFinite(syncProgressRaw) ? Math.max(0, Math.min(100, syncProgressRaw)) : null;
            const statusRaw = String(row.status ?? row.state ?? '').trim().toLowerCase();
            const status = statusRaw || null;
            const checkedAt =
              normalizeIsoTimestamp(row.checked_at ?? row.checkedAt ?? row.last_seen ?? row.lastSeen) ?? null;
            const nodeLabel = String(row.node_name ?? row.nodeName ?? row.label ?? '').trim() || null;

            if (!ip || isIP(ip) === 0 || port <= 0 || port > 65535) {
              return null;
            }

            return {
              ip,
              port,
              blockHeight,
              bestBlockHash,
              peerCount,
              walletVersion,
              protocolVersion,
              syncProgress,
              status,
              checkedAt,
              nodeLabel,
              isCanonicalFallbackSeed: CORE_STATIC_FALLBACK_SEED_IPS.has(ip),
            };
          })
          .filter((row): row is NonNullable<typeof row> => Boolean(row))
          .slice(0, 100);

        return { success: true as const, data: normalized };
      })();
    }

    const activeInFlight = preReleaseNodesInFlight;
    try {
      const payload = await activeInFlight;
      preReleaseNodesLastFailureAtMs = 0;
      preReleaseNodesCache = { atMs: Date.now(), payload };
      return res.json(payload);
    } finally {
      if (preReleaseNodesInFlight === activeInFlight) {
        preReleaseNodesInFlight = null;
      }
    }
  } catch (error) {
    preReleaseNodesLastFailureAtMs = Date.now();
    if (preReleaseNodesCache && Date.now() - preReleaseNodesCache.atMs < PRE_RELEASE_NODES_STALE_MAX_AGE_MS) {
      return res.json(preReleaseNodesCache.payload);
    }
    logger.debug('Could not fetch monitored test nodes:', error);
    return res.json({
      success: true,
      data: [],
    });
  }
});

export default router;
