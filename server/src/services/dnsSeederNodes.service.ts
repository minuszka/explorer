import { isIP } from 'node:net';
import axios from 'axios';
import type { DnsSeederNodeContract, DnsSeederNodesApiResponse } from '@defcon/shared';
import { config } from '../config';
import { rpcService } from './rpc.service';

const ROW_LIMIT = 10_000;
const RESPONSE_BYTES_LIMIT = 5 * 1024 * 1024;
const CACHE_TTL_MS = Math.max(1000, Math.min(10_000, config.cache.ttlSeconds * 1000));
type FeedMeta = DnsSeederNodesApiResponse['meta']['dnsSeeder'];
type FeedSnapshot = { data: DnsSeederNodeContract[]; meta: FeedMeta };

function integer(raw: unknown): number | null {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw.trim()))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const ip = raw.trim();
  if (isIP(ip) === 4) return ip;
  // Scoped IPv6 addresses are local-interface identifiers, not public service identities.
  if (isIP(ip) !== 6 || ip.includes('%')) return null;
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = normalized.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (!mapped) return normalized;
  const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function endpoint(ip: string, port: number): string { return `[${ip}]:${port}`; }

function peerEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^\[([^\]]+)\]:(\d+)$/) ?? raw.match(/^([^:]+):(\d+)$/);
  if (!match) return null;
  const ip = canonicalIp(match[1]), port = integer(match[2]);
  return ip && port != null && port > 0 && port <= 65535 ? endpoint(ip, port) : null;
}

function versionLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw.trim().replace(/^\/+|\/+$/g, '').replace(/^(?:DeFCoN(?: Core)?|Dash Core):/i, '').trim() || null;
}

function lastSeen(raw: unknown, now: number): string | null {
  const time = typeof raw === 'number' && Number.isFinite(raw)
    ? (raw > 1_000_000_000_000 ? raw : raw * 1000)
    : typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)
      ? Date.parse(raw) : NaN;
  return Number.isFinite(time) && time >= 0 && time <= now ? new Date(time).toISOString() : null;
}

function normalizeFeed(raw: unknown, fetchedAt: string, lastAttemptAt: string): FeedSnapshot {
  const container = raw as { data?: unknown; nodes?: unknown } | null;
  const rows: unknown[] | null = Array.isArray(raw) ? raw
    : Array.isArray(container?.data) ? container.data : Array.isArray(container?.nodes) ? container.nodes : null;
  if (!rows) throw new Error('Unrecognized DNS seeder feed');
  const meta: FeedMeta = { status: 'ok', fetchedAt, lastAttemptAt, sourceObservedAt: null,
    completeness: 'unknown', receivedRows: rows.length, rejectedRows: 0, duplicateRows: 0,
    omittedRows: 0, returnedRows: 0, limit: ROW_LIMIT };
  const data: DnsSeederNodeContract[] = [], seen = new Set<string>();
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { meta.rejectedRows++; continue; }
    const row = item as Record<string, unknown>;
    const ip = canonicalIp(row.ip), port = integer(row.port);
    if (!ip || port == null || port < 1 || port > 65535) { meta.rejectedRows++; continue; }
    const key = endpoint(ip, port);
    if (seen.has(key)) { meta.duplicateRows++; continue; }
    seen.add(key);
    if (data.length >= ROW_LIMIT) { meta.omittedRows++; continue; }
    const uptimeRaw = String(row.uptime_2h ?? row.uptime2h ?? '').trim();
    const uptime = /^\d+(?:\.\d+)?%?$/.test(uptimeRaw) ? Number(uptimeRaw.replace('%', '')) : NaN;
    const hash = row.bestBlockHash ?? row.best_block_hash ?? row.blockHash ?? row.block_hash ?? row.hash;
    const walletVersion = versionLabel(row.version ?? row.wallet_version ?? row.walletVersion ?? row.subver
      ?? row.user_agent ?? row.userAgent ?? row.agent ?? row.version_string ?? row.versionString);
    const protocolVersion = integer(row.protocol_version ?? row.protocolVersion ?? row.protocol ?? row.proto);
    data.push({ ip, port, blockHeight: null,
      snapshotBlockHeight: integer(row.block_height ?? row.blockHeight ?? row.height ?? row.blocks),
      bestBlockHash: typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash.trim()) ? hash.trim() : null,
      isLivePeer: false, livePeerObservedAt: null,
      uptime2h: Number.isFinite(uptime) && uptime <= 100 ? uptime : null,
      lastSeen: lastSeen(row.last_seen ?? row.lastSeen, Date.parse(fetchedAt)),
      walletVersion, walletVersionSource: walletVersion ? 'dns-seeder' : null,
      protocolVersion, protocolVersionSource: protocolVersion != null ? 'dns-seeder' : null,
      // getpeerinfo counts our connections, not this remote node's connections.
      peerCount: integer(row.peer_count ?? row.peerCount ?? row.peers ?? row.connections) });
  }
  meta.returnedRows = data.length;
  return { data, meta };
}

/** Read-only adapters for the existing configured feed and local daemon. No active port probes. */
export class DnsSeederNodesService {
  private feedUrl = '';
  private feedCache: FeedSnapshot | null = null;
  private lastFailureAt: number | null = null;
  private lastAttemptAt: string | null = null;
  private snapshotCache: { at: number; payload: DnsSeederNodesApiResponse } | null = null;
  private inFlight: Promise<DnsSeederNodesApiResponse> | null = null;
  private generation = 0;

  private async readFeed(url: string, generation: number): Promise<FeedSnapshot> {
    const now = Date.now();
    const stale = (): FeedSnapshot | null => generation === this.generation && this.feedCache && this.feedCache.meta.fetchedAt
      && Date.now() - Date.parse(this.feedCache.meta.fetchedAt) < config.nodeInventory.staleMaxAgeMs
      ? { data: this.feedCache.data, meta: { ...this.feedCache.meta, status: 'stale', lastAttemptAt: this.lastAttemptAt } } : null;
    if (this.lastFailureAt != null && now - this.lastFailureAt < config.nodeInventory.failureBackoffMs) {
      const cached = stale();
      if (cached) return cached;
      throw new Error('DNS seeder feed unavailable during backoff');
    }
    const attemptAt = new Date(now).toISOString();
    this.lastAttemptAt = attemptAt;
    try {
      const response = await axios.get(url, { timeout: config.nodeInventory.requestTimeoutMs,
        maxContentLength: RESPONSE_BYTES_LIMIT });
      const snapshot = normalizeFeed(response.data, new Date().toISOString(), attemptAt);
      if (generation === this.generation) {
        this.feedCache = snapshot;
        this.lastFailureAt = null;
      }
      return snapshot;
    } catch {
      if (generation === this.generation) this.lastFailureAt = Date.now();
      const cached = stale();
      if (cached) return cached;
      throw new Error('DNS seeder feed unavailable');
    }
  }

  private async refresh(url: string, generation: number): Promise<DnsSeederNodesApiResponse> {
    // One peer snapshot supplies both height and version, with one observation time.
    const [feedResult, peerResult] = await Promise.allSettled([
      this.readFeed(url, generation),
      rpcService.getPeerInfo().then((peers: unknown) => {
        if (!Array.isArray(peers)) throw new Error('Invalid peer snapshot');
        return { peers, observedAt: new Date().toISOString() };
      }),
    ]);
    if (feedResult.status === 'rejected') throw feedResult.reason;
    const peers = new Map<string, Record<string, unknown>>();
    if (peerResult.status === 'fulfilled') for (const peer of peerResult.value.peers) {
      if (!peer || typeof peer !== 'object') continue;
      const row = peer as Record<string, unknown>;
      // Inbound addr contains the remote ephemeral port, not a verified listening service.
      if (row.inbound !== false) continue;
      const key = peerEndpoint(row.addr);
      if (key && !peers.has(key)) peers.set(key, row);
    }
    const observedAt = peerResult.status === 'fulfilled' ? peerResult.value.observedAt : null;
    const data = feedResult.value.data.map((node) => {
      const peer = peers.get(endpoint(node.ip, node.port));
      if (!peer) return node;
      const heights = [integer(peer.synced_headers), integer(peer.synced_blocks)].filter((h): h is number => h != null);
      const walletVersion = versionLabel(peer.subver), protocolVersion = integer(peer.version);
      return { ...node, isLivePeer: true, livePeerObservedAt: observedAt,
        blockHeight: heights.length ? Math.max(...heights) : null,
        ...(walletVersion ? { walletVersion, walletVersionSource: 'explorer-daemon' as const } : {}),
        ...(protocolVersion != null ? { protocolVersion, protocolVersionSource: 'explorer-daemon' as const } : {}) };
    });
    return { success: true, data, meta: { generatedAt: new Date().toISOString(), dnsSeeder: feedResult.value.meta,
      daemonPeers: { status: peerResult.status === 'fulfilled' ? 'ok' : 'unavailable', observedAt },
      portFailureEvidence: 'unavailable' } };
  }

  async getSnapshot(): Promise<DnsSeederNodesApiResponse> {
    const url = config.nodeInventory.dnsSeederApiUrl;
    if (url !== this.feedUrl) {
      this.generation++;
      this.feedUrl = url;
      this.feedCache = null;
      this.lastFailureAt = null;
      this.lastAttemptAt = null;
      this.snapshotCache = null;
      this.inFlight = null;
    }
    if (!url) return { success: true, data: [], meta: { generatedAt: new Date().toISOString(),
      dnsSeeder: { status: 'disabled', fetchedAt: null, lastAttemptAt: null, sourceObservedAt: null,
        completeness: 'unknown', receivedRows: 0, rejectedRows: 0, duplicateRows: 0, omittedRows: 0, returnedRows: 0, limit: ROW_LIMIT },
      daemonPeers: { status: 'not-requested', observedAt: null }, portFailureEvidence: 'unavailable' } };
    const cached = this.snapshotCache;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS
      && (cached.payload.meta.dnsSeeder.status !== 'stale'
        || Date.now() - Date.parse(cached.payload.meta.dnsSeeder.fetchedAt!) < config.nodeInventory.staleMaxAgeMs)) return cached.payload;
    if (!this.inFlight) {
      const generation = this.generation;
      this.inFlight = this.refresh(url, generation).then((payload) => {
        if (generation === this.generation) this.snapshotCache = { at: Date.now(), payload };
        return payload;
      });
    }
    const active = this.inFlight;
    try { return await active; } finally { if (this.inFlight === active) this.inFlight = null; }
  }
}

export const dnsSeederNodesService = new DnsSeederNodesService();
