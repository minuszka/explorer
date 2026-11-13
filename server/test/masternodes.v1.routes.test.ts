import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';
import {
  banWaveAnalysisApiResponseSchema,
  masternodeDetailApiResponseSchema,
  masternodeEventsApiResponseSchema,
  masternodeNodeEventsApiResponseSchema,
} from '@defcon/shared/dist/contracts';
import masternodesV1Routes from '../src/routes/v1/masternodes.v1.routes';
import { getEnrichedNodes } from '../src/services/masternode.service';
import { MasternodeEvent } from '../src/models/MasternodeEvent';
import { NodeInventory } from '../src/models/NodeInventory';
import { rpcService } from '../src/services/rpc.service';

vi.mock('../src/services/masternode.service', () => ({
  getEnrichedNodes: vi.fn(),
}));

function mockEventFind(rows: Array<Record<string, unknown>>) {
  const query = {
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(rows),
  };
  vi.spyOn(MasternodeEvent, 'find').mockReturnValue(query as never);
}

function mockInventoryFind(rows: Array<Record<string, unknown>> = []) {
  const query = {
    lean: vi.fn().mockResolvedValue(rows),
  };
  vi.spyOn(NodeInventory, 'find').mockReturnValue(query as never);
}

describe('masternodes v1 ban wave history', () => {
  const app = express();
  app.use('/api/v1/masternodes', masternodesV1Routes);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps historical waves after nodes recover and reports current state separately', async () => {
    const detectedAt = new Date(Date.now() - 60 * 60 * 1000);
    const recoveredAt = new Date(Date.now() - 10 * 60 * 1000);

    vi.mocked(getEnrichedNodes).mockResolvedValue([
      {
        id: 'node-a',
        status: 'ENABLED',
        service: '10.0.0.1:8192',
        proTxHash: 'protx-a',
        ip: '10.0.0.1',
        port: 8192,
        countryCode: 'DE',
        countryName: 'Germany',
        provider: 'Contabo',
        operatorPubkey: 'op-a',
        payoutAddress: 'Dabc',
      },
      {
        id: 'node-b',
        status: 'POSE_BANNED',
        service: '10.0.0.2:8192',
        proTxHash: 'protx-b',
        ip: '10.0.0.2',
        port: 8192,
        countryCode: 'US',
        countryName: 'United States',
        provider: 'RackNerd',
        operatorPubkey: 'op-b',
        payoutAddress: 'Ddef',
      },
      {
        id: 'node-c',
        status: 'POSE_BANNED',
        service: '10.0.0.3:8192',
        proTxHash: 'protx-c',
        ip: '10.0.0.3',
        port: 8192,
        countryCode: 'US',
        countryName: 'United States',
        provider: 'RackNerd',
        operatorPubkey: 'op-c',
        payoutAddress: 'Dghi',
      },
    ] as never);

    mockEventFind([
      {
        nodeId: 'node-a',
        proTxHash: 'protx-a',
        service: '10.0.0.1:8192',
        previousStatus: 'POSE_BAN_HEIGHT',
        detectedAt,
        eventStatus: 'recovered',
        ip: '10.0.0.1',
        countryCode: 'DE',
        countryName: 'Germany',
        provider: 'Contabo',
        operatorPubkey: 'op-a',
        payoutAddress: 'Dabc',
        poseBanHeight: 100,
        detectedHeight: 100,
        recoveredAt,
        recoveredHeight: 105,
        recoveryTransition: 'POSE_BANNED -> ENABLED',
      },
      {
        nodeId: 'node-b',
        proTxHash: 'protx-b',
        service: '10.0.0.2:8192',
        previousStatus: 'POSE_BAN_HEIGHT',
        detectedAt,
        eventStatus: 'banned',
        ip: '10.0.0.2',
        countryCode: 'US',
        countryName: 'United States',
        provider: 'RackNerd',
        operatorPubkey: 'op-b',
        payoutAddress: 'Ddef',
        poseBanHeight: 100,
        detectedHeight: 100,
      },
      {
        nodeId: 'node-c',
        proTxHash: 'protx-c',
        service: '10.0.0.3:8192',
        previousStatus: 'POSE_BAN_HEIGHT',
        detectedAt,
        eventStatus: 'banned',
        ip: '10.0.0.3',
        countryCode: 'US',
        countryName: 'United States',
        provider: 'RackNerd',
        operatorPubkey: 'op-c',
        payoutAddress: 'Dghi',
        poseBanHeight: 100,
        detectedHeight: 100,
      },
    ]);
    mockInventoryFind([
      { ip: '10.0.0.1', walletVersion: '22.1.2', protocolVersion: 70238, lastObservedAt: new Date() },
      { ip: '10.0.0.2', walletVersion: '22.1.3', protocolVersion: 70238, lastObservedAt: new Date() },
    ]);

    const res = await request(app)
      .get('/api/v1/masternodes/ban-waves')
      .query({ hours: 24, windowMinutes: 30, minNodes: 3 });

    expect(res.status).toBe(200);
    expect(banWaveAnalysisApiResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.success).toBe(true);
    expect(res.body.data.currentPoseBanned).toBe(2);
    expect(res.body.data.currentValid).toBe(1);
    expect(res.body.data.freshDrops24h).toBe(3);
    expect(res.body.data.eventBreakdown.recoveredEvents).toBe(1);
    expect(res.body.data.eventBreakdown.stillBannedEvents).toBe(2);
    expect(res.body.data.timelineModes).toHaveProperty('recovered');
    expect(res.body.data.timelineModes).toHaveProperty('still');

    const wave = res.body.data.waves[0];
    expect(wave.totalNodes).toBe(3);
    expect(wave.recoveredCount).toBe(1);
    expect(wave.stillBannedCount).toBe(2);
    expect(wave.providers).toEqual(['Contabo', 'RackNerd']);
    expect(wave.versions).toEqual(['22.1.2', '22.1.3']);
    // Inventory membership freshness must never stand in for a version observation.
    expect(wave.nodes[0].versionObservedAt).toBeNull();
    expect(wave.nodes.map((node: { status: string }) => node.status).sort()).toEqual([
      'recovered',
      'still_banned',
      'still_banned',
    ]);
  });

  it('separates Q60 history from current state and retains isolated repeated bans', async () => {
    const now = Date.now();
    vi.spyOn(rpcService, 'call').mockImplementation(async (method) => {
      if (method === 'getblockhash') return 'activation-hash' as never;
      if (method === 'getblockheader') return { time: Math.floor((now - 3_600_000) / 1000) } as never;
      throw new Error('Unexpected RPC');
    });
    vi.mocked(getEnrichedNodes).mockResolvedValue([
      { id: 'live-a', proTxHash: 'protx-a', status: 'POSE_PENALTY', posePenalty: 112 },
      { id: 'old-ban', proTxHash: 'old', status: 'POSE_BANNED' },
    ] as never);
    const row = { nodeId: 'node-a', proTxHash: 'protx-a', previousStatus: 'POSE_BAN_HEIGHT', detectedAt: new Date(now - 60_000), service: '198.51.100.1:8192' };
    mockEventFind([
      { ...row, poseBanHeight: 144887, detectedHeight: 144990 },
      { ...row, poseBanHeight: 144888 },
      { ...row, poseBanHeight: 144888 },
      { ...row, poseBanHeight: 144947, detectedAt: new Date(now - 30_000) },
      { ...row, poseBanHeight: null, previousStatus: 'ENABLED', detectedHeight: 144990 },
    ]);
    mockInventoryFind();
    const res = await request(app).get('/api/v1/masternodes/ban-waves').query({ scope: 'q60', hours: 2160 });
    expect(res.status).toBe(200);
    expect(banWaveAnalysisApiResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.data.analysisScope).toMatchObject({ kind: 'q60', activationHeight: 144888, unclassifiedEvents: 1, historyLimited: false });
    expect(res.body.data.currentPoseBanned).toBe(1);
    expect(res.body.data.trackedNodes).toEqual([expect.objectContaining({ proTxHash: 'protx-a', banCount: 2, lastBanHeight: 144947, currentStatus: 'POSE_PENALTY', currentPenalty: 112 })]);
    expect(res.body.data.waves).toHaveLength(0);
    expect(res.body.data.timeline.reduce((sum: number, point: { total: number }) => sum + point.total, 0)).toBe(2);
    expect(res.body.data.freshDropEvents24h).toBe(2);
    expect(res.body.data.bucket).toBe('15min');
  });

  it('does not invent an activation timestamp when Q60 RPC lookup fails', async () => {
    vi.spyOn(rpcService, 'call').mockRejectedValue(new Error('RPC unavailable'));
    const res = await request(app).get('/api/v1/masternodes/ban-waves').query({ scope: 'q60', hours: 2159 });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it('shows older confirmed bans in the selected timeline without counting them as fresh 24h', async () => {
    vi.mocked(getEnrichedNodes).mockResolvedValue([]);
    mockEventFind([{ nodeId: 'older', proTxHash: 'older', previousStatus: 'POSE_BAN_HEIGHT', poseBanHeight: 144900, detectedAt: new Date(Date.now() - 30 * 3_600_000) }]);
    mockInventoryFind();
    const res = await request(app).get('/api/v1/masternodes/ban-waves').query({ hours: 48 });
    expect(res.status).toBe(200);
    expect(res.body.data.freshDrops24h).toBe(0);
    expect(res.body.data.trackedNodes).toHaveLength(1);
    expect(res.body.data.timeline.reduce((sum: number, point: { total: number }) => sum + point.total, 0)).toBe(1);
    expect(res.body.data.trackedNodes[0].currentStatus).toBeNull();
  });

  it('marks stale Q60 history when an expired cached view cannot be refreshed', async () => {
    const now = Date.now();
    const rpc = vi.spyOn(rpcService, 'call').mockImplementation(async (method) =>
      (method === 'getblockhash' ? 'activation-hash' : { time: Math.floor((now - 3_600_000) / 1000) }) as never);
    vi.mocked(getEnrichedNodes).mockResolvedValue([]);
    mockEventFind([]);
    mockInventoryFind();
    const query = { scope: 'q60', hours: 48 };
    const first = await request(app).get('/api/v1/masternodes/ban-waves').query(query);
    expect(first.status).toBe(200);
    vi.spyOn(Date, 'now').mockReturnValue(now + 180_000);
    rpc.mockRejectedValue(new Error('RPC unavailable'));
    const stale = await request(app).get('/api/v1/masternodes/ban-waves').query(query);
    expect(stale.status).toBe(200);
    expect(stale.body.data.dataStatus).toBe('stale');
    expect(stale.body.data.generatedAt).toBe(first.body.data.generatedAt);
  });

  it('normalizes stored event timestamps before returning the shared event contract', async () => {
    const detectedAt = new Date(Date.now() - 60_000);
    const query = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([
        {
          _id: { toString: () => 'event-1' },
          nodeId: 'node-a',
          service: '10.0.0.1:8192',
          previousStatus: 'ENABLED',
          currentStatus: 'POSE_BANNED',
          detectedAt,
          countryCode: null,
          countryName: null,
        },
      ]),
    };
    vi.spyOn(MasternodeEvent, 'find').mockReturnValue(query as never);

    const res = await request(app).get('/api/v1/masternodes/events').query({ hours: 1, limit: 10 });

    expect(res.status).toBe(200);
    expect(masternodeEventsApiResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.data.events[0]).toMatchObject({
      _id: 'event-1',
      detectedAt: detectedAt.toISOString(),
    });
  });
});

describe('masternodes v1 per-node routes', () => {
  const app = express();
  app.use('/api/v1/masternodes', masternodesV1Routes);
  const proTxHash = 'b'.repeat(64);
  const node = {
    id: `${'c'.repeat(64)}-1`,
    service: '203.0.113.20:8192',
    ip: '203.0.113.20',
    port: 8192,
    status: 'ENABLED',
    protocol: 70242,
    lastSeen: null,
    activeSeconds: 3_600,
    isTor: false,
    countryCode: 'DE',
    countryName: 'Germany',
    proTxHash,
    ownerAddress: 'DownerAddress',
    payoutAddress: 'DpayoutAddress',
    collateralAddress: 'DcollateralAddress',
    registeredHeight: 120_000,
    registeredAt: 1_725_000_000,
    poseBanHeight: null,
    poseBanAt: null,
    poseRevivedHeight: 125_000,
    posePenalty: 12,
    operatorPubkey: 'operator-key',
    votingAddress: 'DvotingAddress',
    collateralAmount: 10_000,
    provider: 'Example Host',
    providerSource: 'mmdb' as const,
    asn: 64_500,
    asnOrg: 'Example Host AS',
    providerTagCidr: null,
    providerTagSource: null,
    providerConfidence: null,
    providerEvidenceUrl: null,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns one node by proTxHash in the shared detail contract, and 404 for an unknown one', async () => {
    vi.mocked(getEnrichedNodes).mockResolvedValue([node] as never);

    const res = await request(app).get(`/api/v1/masternodes/${proTxHash}`);
    expect(res.status).toBe(200);
    const parsed = masternodeDetailApiResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: node.id, proTxHash, posePenalty: 12, poseRevivedHeight: 125_000 });

    const missing = await request(app).get(`/api/v1/masternodes/${'d'.repeat(64)}`);
    expect(missing.status).toBe(404);
  });

  it('keeps serving /events when a stored ban has recovered, whose recoveredAt is still a Date', async () => {
    const detectedAt = new Date(Date.now() - 30 * 60 * 1000);
    const recoveredAt = new Date(Date.now() - 10 * 60 * 1000);
    const query = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          nodeId: node.id,
          service: node.service,
          previousStatus: 'POSE_BAN_HEIGHT',
          currentStatus: 'ENABLED',
          detectedAt,
          eventType: 'ban',
          eventStatus: 'recovered',
          proTxHash,
          poseBanHeight: 124_000,
          detectedHeight: 124_000,
          recoveredAt,
          recoveredHeight: 125_000,
          recoveryTransition: 'POSE_BANNED -> ENABLED',
          updatedAt: recoveredAt,
        },
      ]),
    };
    vi.spyOn(MasternodeEvent, 'find').mockReturnValue(query as never);

    // A query of its own, so the route's short cache cannot answer from another test.
    const res = await request(app).get('/api/v1/masternodes/events').query({ hours: 2, limit: 20 });
    expect(res.status).toBe(200);
    expect(masternodeEventsApiResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.data.events[0]).toMatchObject({ recoveredAt: recoveredAt.toISOString(), poseBanHeight: 124_000 });
  });

  it('returns the stored events of the node id in the shared event contract', async () => {
    vi.mocked(getEnrichedNodes).mockResolvedValue([node] as never);
    const detectedAt = new Date('2026-11-01T10:00:00.000Z');
    const recoveredAt = new Date('2026-11-02T10:00:00.000Z');
    const query = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          __v: 0,
          nodeId: node.id,
          service: node.service,
          previousStatus: 'POSE_BAN_HEIGHT',
          currentStatus: 'POSE_BANNED',
          detectedAt,
          eventKey: `ban:${proTxHash}:124000`,
          eventType: 'ban',
          eventStatus: 'recovered',
          proTxHash,
          poseBanHeight: 124_000,
          detectedHeight: 124_000,
          recoveredAt,
          recoveredHeight: 125_000,
          recoveryTransition: 'POSE_BANNED->ENABLED',
          updatedAt: recoveredAt,
        },
        {
          _id: new Types.ObjectId(),
          nodeId: node.id,
          service: '',
          previousStatus: 'ENABLED',
          currentStatus: 'POSE_PENALTY',
          detectedAt,
          eventType: 'status',
          eventStatus: 'observed',
          proTxHash: null,
        },
      ]),
    };
    const find = vi.spyOn(MasternodeEvent, 'find').mockReturnValue(query as never);

    const res = await request(app).get(`/api/v1/masternodes/${encodeURIComponent(node.id)}/events`).query({ limit: 50 });
    expect(res.status).toBe(200);
    expect(find).toHaveBeenCalledWith({ nodeId: node.id });
    expect(masternodeNodeEventsApiResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.data[0]).toMatchObject({
      proTxHash,
      eventType: 'ban',
      poseBanHeight: 124_000,
      recoveredAt: recoveredAt.toISOString(),
      detectedAt: detectedAt.toISOString(),
    });
    expect(typeof res.body.data[0]._id).toBe('string');
  });
});
