import express from 'express';
import request from 'supertest';
import axios from 'axios';
import networkRoutes, { invalidateNetworkCache } from '../src/routes/network.routes';
import { config } from '../src/config';
import { rpcService } from '../src/services/rpc.service';
import { dnsSeederNodesService } from '../src/services/dnsSeederNodes.service';
import { logger } from '../src/utils/logger';

const DNS_SEEDER_FEED_URL = 'https://seeder.example.com/nodes';
const TEST_NODES_FEED_URL = 'https://seeder.example.com/fullnodes';

describe('network routes', () => {
  const app = express();
  app.use('/api/network', networkRoutes);

  // The feed handlers read their URLs from the shared config on every request,
  // so each test sets the feeds it needs and the original values are restored.
  const originalFeeds = {
    dnsSeederApiUrl: config.nodeInventory.dnsSeederApiUrl,
    preReleaseNodesApiUrl: config.nodeInventory.preReleaseNodesApiUrl,
    preReleaseNodesApiKey: config.nodeInventory.preReleaseNodesApiKey,
  };
  function setFeeds(feeds: Partial<typeof originalFeeds>): void {
    Object.assign(config.nodeInventory, feeds);
  }

  afterEach(() => {
    Object.assign(config.nodeInventory, originalFeeds);
    invalidateNetworkCache();
    jest.restoreAllMocks();
  });

  it('GET /api/network returns 503 when RPC calls fail', async () => {
    jest.spyOn(rpcService, 'getNetworkInfo').mockRejectedValue(new Error('rpc down'));
    jest.spyOn(rpcService, 'getPeerInfo').mockResolvedValue([]);
    jest.spyOn(rpcService, 'getBlockchainInfo').mockResolvedValue({ blocks: 123, headers: 123 });

    const res = await request(app).get('/api/network');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
  });

  it('GET /api/network returns normalized network payload', async () => {
    jest.spyOn(rpcService, 'getNetworkInfo').mockResolvedValue({
      connections: 2,
      protocolversion: 70918,
      subversion: '/DeFCoN Core:1.0.0/',
    });
    jest.spyOn(rpcService, 'getPeerInfo').mockResolvedValue([
      {
        addr: '203.0.113.11:8192',
        version: 70918,
        subver: '/DeFCoN Core:1.0.0/',
        inbound: false,
      },
    ]);
    jest.spyOn(rpcService, 'getBlockchainInfo').mockResolvedValue({ blocks: 123_456, headers: 123_457 });

    const res = await request(app).get('/api/network');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        connections: 2,
        protocolversion: 70918,
        subversion: '/DeFCoN Core:1.0.0/',
        blockHeight: 123456,
        headerHeight: 123457,
      },
    });
    expect(Array.isArray(res.body.data.peers)).toBe(true);
    expect(res.body.data.peers[0]).toMatchObject({
      addr: '203.0.113.11:8192',
      isIpv6: false,
    });
    expect(res.headers['cache-control']).toMatch(/^private, max-age=\d+, stale-while-revalidate=\d+$/);
    expect(res.headers['cdn-cache-control']).toMatch(/^public, max-age=\d+, stale-while-revalidate=\d+$/);
    expect(res.headers['cloudflare-cdn-cache-control']).toBe(res.headers['cdn-cache-control']);
  });

  it('GET /api/network falls back to getblockcount when blockchain info is unavailable', async () => {
    jest.spyOn(rpcService, 'getNetworkInfo').mockResolvedValue({
      connections: 1,
      protocolversion: 70918,
      subversion: '/DeFCoN Core:1.0.0/',
    });
    jest.spyOn(rpcService, 'getPeerInfo').mockResolvedValue([]);
    jest.spyOn(rpcService, 'getBlockchainInfo').mockRejectedValue(new Error('temporary RPC failure'));
    jest.spyOn(rpcService, 'getBlockCount').mockResolvedValue(123_999);

    const res = await request(app).get('/api/network');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      blockHeight: 123999,
      headerHeight: 123999,
    });
  });

  it('GET /api/network/dns-seeder-nodes disables browser and CDN response caching', async () => {
    setFeeds({ dnsSeederApiUrl: DNS_SEEDER_FEED_URL });
    const axiosGet = jest.spyOn(axios, 'get').mockResolvedValue({ data: [] });
    jest.spyOn(rpcService, 'getPeerInfo').mockResolvedValue([]);

    const res = await request(app).get('/api/network/dns-seeder-nodes');

    expect(res.status).toBe(200);
    expect(axiosGet).toHaveBeenCalledWith(DNS_SEEDER_FEED_URL, expect.objectContaining({ timeout: expect.any(Number) }));
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, max-age=0');
    expect(res.headers['cdn-cache-control']).toBeUndefined();
    expect(res.headers['cloudflare-cdn-cache-control']).toBeUndefined();
  });

  it.each([
    ['/api/network/dns-seeder-nodes', { dnsSeederApiUrl: '' }],
    ['/api/network/pre-release-nodes', { preReleaseNodesApiUrl: '', preReleaseNodesApiKey: '' }],
  ])('GET %s returns an empty snapshot without polling when its feed is disabled', async (path, feeds) => {
    setFeeds(feeds);
    const axiosGet = jest.spyOn(axios, 'get');
    const logError = jest.spyOn(logger, 'error');

    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: [] });
    if (path.endsWith('/dns-seeder-nodes')) {
      expect(res.body.meta.dnsSeeder.status).toBe('disabled');
      expect(res.body.meta.daemonPeers.status).toBe('not-requested');
    }
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, max-age=0');
    expect(axiosGet).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('GET /api/network/dns-seeder-nodes returns 503, not an empty healthy list, when no usable feed remains', async () => {
    jest.spyOn(dnsSeederNodesService, 'getSnapshot').mockRejectedValue(new Error('DNS seeder feed unavailable'));
    const res = await request(app).get('/api/network/dns-seeder-nodes');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(res.body.data).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, max-age=0');
  });

  it('GET /api/network/pre-release-nodes sends the feed API key and normalizes rows', async () => {
    setFeeds({ preReleaseNodesApiUrl: TEST_NODES_FEED_URL, preReleaseNodesApiKey: 'feed-key' });
    const axiosGet = jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        nodes: [
          {
            ip: '203.0.113.10',
            port: 8192,
            block_height: 150_000,
            best_hash: 'b'.repeat(64),
            connections: 12,
            version: '23.0.0',
            protocol_version: 70242,
            status: 'Synced',
            node_name: 'test-node-a',
          },
          { ip: 'not-an-ip', port: 8192 },
        ],
      },
    });

    const res = await request(app).get('/api/network/pre-release-nodes');

    expect(res.status).toBe(200);
    expect(axiosGet).toHaveBeenCalledWith(
      TEST_NODES_FEED_URL,
      expect.objectContaining({ headers: { 'X-API-Key': 'feed-key' } })
    );
    expect(res.body.data).toEqual([
      expect.objectContaining({
        ip: '203.0.113.10',
        port: 8192,
        blockHeight: 150000,
        bestBlockHash: 'b'.repeat(64),
        peerCount: 12,
        walletVersion: '23.0.0',
        protocolVersion: 70242,
        status: 'synced',
        nodeLabel: 'test-node-a',
        isCanonicalFallbackSeed: false,
      }),
    ]);
  });
});
