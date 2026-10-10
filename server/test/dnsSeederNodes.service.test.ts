import axios from 'axios';
import { dnsSeederNodesApiResponseSchema } from '@defcon/shared';
import { DnsSeederNodesService } from '../src/services/dnsSeederNodes.service';
import { config } from '../src/config';
import { rpcService } from '../src/services/rpc.service';

describe('existing DNS seeder / daemon peer sources', () => {
  const original = { ...config.nodeInventory };
  let service: DnsSeederNodesService;
  let feed: ReturnType<typeof jest.spyOn>;
  let peers: ReturnType<typeof jest.spyOn>;
  const row = (extra = {}) => ({ ip: '203.0.113.10', port: 8192, ...extra });
  const peer = (extra = {}) => ({ addr: '203.0.113.10:8192', inbound: false, ...extra });
  beforeEach(() => {
    jest.useFakeTimers({ toFake: ['Date'] });
    jest.setSystemTime(new Date('2026-10-10T14:00:00Z'));
    Object.assign(config.nodeInventory, { dnsSeederApiUrl: 'https://seeder.example/nodes', failureBackoffMs: 30_000, staleMaxAgeMs: 60_000 });
    service = new DnsSeederNodesService();
    feed = jest.spyOn(axios, 'get').mockResolvedValue({ data: [row()] });
    peers = jest.spyOn(rpcService, 'getPeerInfo').mockResolvedValue([]);
  });
  afterEach(() => {
    Object.assign(config.nodeInventory, original);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  function advance(ms = 10_001) { jest.setSystemTime(Date.now() + ms); }
  async function snapshot() {
    const result = await service.getSnapshot();
    expect(dnsSeederNodesApiResponseSchema.safeParse(result).success).toBe(true);
    return result;
  }

  it('requires the exact outbound service, not just an IP or inbound connection', async () => {
    feed.mockResolvedValue({ data: [row(), row({ port: 8193 }), row({ port: 8194 })] });
    peers.mockResolvedValue([peer({ synced_headers: 101, synced_blocks: 100, subver: '/DeFCoN:23.0.0/', version: 70242 }),
      peer({ addr: '203.0.113.10:8193', inbound: true, synced_blocks: 999 }),
      peer({ addr: '203.0.113.10:8194', synced_blocks: 999, inbound: undefined })]);
    const result = await snapshot();
    expect(result.data.map(n => n.isLivePeer)).toEqual([true, false, false]);
    expect(result.data[0]).toMatchObject({ blockHeight: 101, peerCount: null, walletVersion: '23.0.0', walletVersionSource: 'explorer-daemon' });
    expect(result.data[1].blockHeight).toBeNull();
    expect(peers).toHaveBeenCalledTimes(1);
    expect(result.meta.portFailureEvidence).toBe('unavailable');
  });

  it('accepts an observed connection without inventing height zero from missing or negative heights', async () => {
    peers.mockResolvedValue([peer({ synced_headers: -1, synced_blocks: undefined })]);
    const result = await snapshot();
    expect(result.data[0]).toMatchObject({ isLivePeer: true, blockHeight: null, livePeerObservedAt: result.meta.daemonPeers.observedAt });
  });

  it('canonicalizes equivalent IPv6 and IPv4-mapped addresses and deduplicates endpoints', async () => {
    feed.mockResolvedValue({ data: { nodes: [row({ ip: '2001:0DB8:0:0:0:0:0:1' }), row({ ip: '2001:db8::1' }),
      row({ ip: '::ffff:203.0.113.10' }), row()] } });
    peers.mockResolvedValue([peer({ addr: '[2001:db8::1]:8192' }), peer({ addr: '[::ffff:cb00:710a]:8192' })]);
    const result = await snapshot();
    expect(result.data.map(n => [n.ip, n.isLivePeer])).toEqual([['2001:db8::1', true], ['203.0.113.10', true]]);
    expect(result.meta.dnsSeeder).toMatchObject({ receivedRows: 4, returnedRows: 2, duplicateRows: 2, rejectedRows: 0 });
  });

  it('rejects malformed rows and partial numbers without trusting invalid uptime or timestamps', async () => {
    feed.mockResolvedValue({ data: { data: [null, false, [], row({ port: '8192junk' }), row({ ip: 'example.com' }),
      row({ port: 0 }), row({ port: 65536 }), row({ port: '8192', uptime_2h: '101%', block_height: '123junk', last_seen: 'invalid' }),
      row({ port: 8193, uptime_2h: '50%', last_seen: 1791640800, block_height: '123' }),
      row({ port: 8194, uptime_2h: '5%junk', last_seen: '2099-01-01T00:00:00Z' }), row({ ip: 'fe80::1%eth0' })] } });
    const result = await snapshot();
    expect(result.meta.dnsSeeder).toMatchObject({ receivedRows: 11, rejectedRows: 8, returnedRows: 3 });
    expect(result.data[0]).toMatchObject({ uptime2h: null, snapshotBlockHeight: null, lastSeen: null });
    expect(result.data[1]).toMatchObject({ uptime2h: 50, snapshotBlockHeight: 123, lastSeen: '2026-10-10T14:00:00.000Z' });
    expect(result.data[2]).toMatchObject({ uptime2h: null, lastSeen: null });
  });

  it('keeps crawler hash, height, uptime and last seen separate from fresh peer observations', async () => {
    feed.mockResolvedValue({ data: [row({ block_height: 90, hash: 'a'.repeat(64), uptime2h: 0,
      lastSeen: '2026-10-01T12:00:00Z', walletVersion: '22.0.0', peerCount: 12 })] });
    peers.mockResolvedValue([peer({ synced_blocks: 100, subver: '/DeFCoN Core:23.0.0/' })]);
    const result = await snapshot();
    expect(result.data[0]).toMatchObject({ isLivePeer: true, blockHeight: 100, snapshotBlockHeight: 90,
      bestBlockHash: 'a'.repeat(64), uptime2h: 0, lastSeen: '2026-10-01T12:00:00.000Z', walletVersion: '23.0.0', peerCount: 12 });
    expect(result.meta.dnsSeeder.sourceObservedAt).toBeNull();
    expect(result.meta.dnsSeeder.completeness).toBe('unknown');
  });

  it('returns more than 100 records and reports the explicit bounded limit', async () => {
    feed.mockResolvedValue({ data: Array.from({ length: 10_001 }, (_, i) => row({ port: i + 1 })) });
    const result = await snapshot();
    expect(result.data).toHaveLength(10_000);
    expect(result.meta.dnsSeeder).toMatchObject({ receivedRows: 10_001, returnedRows: 10_000, omittedRows: 1, limit: 10_000 });
    expect(feed).toHaveBeenCalledWith('https://seeder.example/nodes', expect.objectContaining({ maxContentLength: 5 * 1024 * 1024, timeout: expect.any(Number) }));
  });

  it('labels retained feed data stale, preserving its retrieval time while refreshing peers', async () => {
    const first = await snapshot();
    advance();
    feed.mockRejectedValue(new Error('upstream unavailable'));
    peers.mockResolvedValue([peer({ synced_blocks: 102 })]);
    const stale = await snapshot();
    expect(stale.meta.dnsSeeder).toMatchObject({ status: 'stale', fetchedAt: first.meta.dnsSeeder.fetchedAt });
    expect(stale.meta.dnsSeeder.lastAttemptAt).not.toBe(first.meta.dnsSeeder.lastAttemptAt);
    expect(stale.data[0].isLivePeer).toBe(true);
    expect(stale.meta.daemonPeers.observedAt).not.toBe(first.meta.daemonPeers.observedAt);
    advance();
    const backoff = await snapshot();
    expect(backoff.meta.dnsSeeder).toEqual(stale.meta.dnsSeeder);
    expect(feed).toHaveBeenCalledTimes(2);
    advance(60_001);
    await expect(service.getSnapshot()).rejects.toThrow('DNS seeder feed unavailable');
  });

  it('withdraws all direct peer claims on RPC failure instead of recycling old connections', async () => {
    peers.mockResolvedValue([peer({ synced_blocks: 100 })]);
    expect((await snapshot()).data[0].isLivePeer).toBe(true);
    advance();
    peers.mockRejectedValue(new Error('RPC unavailable'));
    const result = await snapshot();
    expect(result.meta.daemonPeers).toEqual({ status: 'unavailable', observedAt: null });
    expect(result.data[0]).toMatchObject({ isLivePeer: false, blockHeight: null, livePeerObservedAt: null });
    expect(result.meta.dnsSeeder.status).toBe('ok');
  });

  it('does not extend the maximum stale age through the short response cache', async () => {
    await snapshot();
    advance(59_000);
    feed.mockRejectedValue(new Error('unavailable'));
    expect((await snapshot()).meta.dnsSeeder.status).toBe('stale');
    advance(1001);
    await expect(service.getSnapshot()).rejects.toThrow('backoff');
    expect(feed).toHaveBeenCalledTimes(2);
  });

  it('treats malformed RPC output as unavailable, and absent peers as unknown', async () => {
    peers.mockResolvedValue({ peers: [] });
    expect((await snapshot()).meta.daemonPeers.status).toBe('unavailable');
    advance();
    peers.mockResolvedValue([]);
    const result = await snapshot();
    expect(result.meta.daemonPeers.status).toBe('ok');
    expect(result.data[0].isLivePeer).toBe(false);
    expect(result.meta.portFailureEvidence).toBe('unavailable');
  });

  it('does not convert an unrecognized feed into a successful empty snapshot and respects failure backoff', async () => {
    feed.mockResolvedValue({ data: { error: 'not a snapshot' } });
    await expect(service.getSnapshot()).rejects.toThrow('DNS seeder feed unavailable');
    await expect(service.getSnapshot()).rejects.toThrow('backoff');
    expect(feed).toHaveBeenCalledTimes(1);
    advance(30_001);
    feed.mockResolvedValue({ data: [] });
    const result = await snapshot();
    expect(result.data).toEqual([]);
    expect(result.meta.dnsSeeder.status).toBe('ok');
  });

  it('marks a malformed refresh stale, rather than discarding the last good feed', async () => {
    const first = await snapshot();
    advance();
    feed.mockResolvedValue({ data: { nodes: null } });
    const result = await snapshot();
    expect(result.data).toEqual(first.data);
    expect(result.meta.dnsSeeder.status).toBe('stale');
  });

  it('coalesces simultaneous requests and caches the original observation times', async () => {
    const [first, second] = await Promise.all([snapshot(), snapshot()]);
    expect(first).toEqual(second);
    advance(500);
    expect(await snapshot()).toEqual(first);
    expect(feed).toHaveBeenCalledTimes(1);
    expect(peers).toHaveBeenCalledTimes(1);
  });

  it('keeps disabled feeds distinct from a valid empty feed and makes no requests', async () => {
    config.nodeInventory.dnsSeederApiUrl = '';
    const result = await snapshot();
    expect(result.meta.dnsSeeder.status).toBe('disabled');
    expect(result.meta.daemonPeers.status).toBe('not-requested');
    expect(feed).not.toHaveBeenCalled();
    expect(peers).not.toHaveBeenCalled();
  });

  it('does not reuse cached data from a different configured feed', async () => {
    await snapshot();
    config.nodeInventory.dnsSeederApiUrl = 'https://other.example/nodes';
    feed.mockRejectedValue(new Error('unavailable'));
    await expect(service.getSnapshot()).rejects.toThrow('unavailable');
    expect(feed).toHaveBeenCalledTimes(2);
  });

  it('does not let an older in-flight feed overwrite a newly configured source', async () => {
    let finishOld!: (value: unknown) => void;
    feed.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const old = service.getSnapshot();
    config.nodeInventory.dnsSeederApiUrl = 'https://other.example/nodes';
    feed.mockResolvedValue({ data: [row({ ip: '203.0.113.20' })] });
    const current = await snapshot();
    finishOld({ data: [row({ ip: '203.0.113.30' })] });
    await old;
    expect((await snapshot()).data).toEqual(current.data);
    expect(current.data[0].ip).toBe('203.0.113.20');
  });

  it('the browser contract rejects fabricated peer claims and inconsistent coverage', async () => {
    const result = await snapshot();
    const forged = structuredClone(result);
    forged.data[0].isLivePeer = true;
    expect(dnsSeederNodesApiResponseSchema.safeParse(forged).success).toBe(false);
    const badCount = structuredClone(result);
    badCount.meta.dnsSeeder.returnedRows++;
    expect(dnsSeederNodesApiResponseSchema.safeParse(badCount).success).toBe(false);
  });
});
