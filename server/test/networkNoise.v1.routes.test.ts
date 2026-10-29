import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { poseEvent, posePayload } from './fixtures/poseTelemetry';
import { NetworkNoiseSequenceConflict } from '../src/services/networkNoiseBatch.service';

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  getSummary: vi.fn(),
}));
const poseMocks = vi.hoisted(() => ({ getEvents: vi.fn() }));

vi.mock('../src/services/networkNoise.service', () => ({
  networkNoiseService: mocks,
}));
vi.mock('../src/services/poseTelemetry.service', () => ({ poseTelemetryService: poseMocks }));

import networkNoiseRoutes from '../src/routes/v1/networkNoise.v1.routes';

const TOKEN = 'a'.repeat(64);

function summaryPayload() {
  return {
    generatedAt: '2026-07-12T09:22:07.000Z',
    windowHours: 24,
    staleAfterSeconds: 300,
    summary: {
      currentScore: 72,
      currentLevel: 'severe' as const,
      knownNodes: 1,
      reportingNodes: 1,
      staleNodes: 0,
      activeSignals: 4,
      chainAlerts: 1,
    },
    nodes: [
      {
        nodeId: 'node-a',
        nodeRole: 'fullnode' as const,
        walletVersion: 'v23.0.0',
        agentVersion: '1.0.0',
        lastReportedAt: '2026-07-12T09:22:07.000Z',
        blockHeight: 99_331,
        bestBlockHash: 'a'.repeat(64),
        chainLockHeight: 99_331,
        chainLockHash: 'a'.repeat(64),
        connections: 8,
        inbound: 5,
        outbound: 3,
        syncing: false,
        noiseScore: 72,
        signalCount: 4,
        activeSignalTypes: ['chainlock_conflict'],
        lastCleanAt: null,
        isStale: false,
      },
    ],
    timeline: [{ bucket: '2026-07-12T09:00:00.000Z', signalType: 'chainlock_conflict', count: 4, nodes: ['node-a'] }],
    recentSignals: [
      {
        nodeId: 'node-a',
        nodeRole: 'fullnode',
        walletVersion: 'v23.0.0',
        signalType: 'chainlock_conflict',
        fingerprint: 'ef0a97b51d4622a99a8d39b1',
        count: 4,
        firstSeenAt: '2026-07-12T09:20:00.000Z',
        lastSeenAt: '2026-07-12T09:21:00.000Z',
        sample: 'AcceptBlockHeader: block <hash> is marked conflicting',
        blockHeight: 99_331,
        bestBlockHash: 'a'.repeat(64),
        chainLockHeight: 99_331,
        chainLockHash: 'a'.repeat(64),
      },
    ],
  };
}

function validPayload() {
  return {
    schemaVersion: 1,
    agentVersion: '1.0.0',
    nodeId: 'node-a',
    nodeRole: 'fullnode',
    observedAt: '2026-07-12T09:22:07Z',
    sequence: 12,
    snapshot: {
      ip: '198.51.100.40',
      walletVersion: 'v23.0.0',
      blockHeight: 99331,
      bestBlockHash: 'a'.repeat(64),
      chainLockHeight: 99331,
      chainLockHash: 'a'.repeat(64),
      connections: 8,
      inbound: 5,
      outbound: 3,
      syncing: false,
    },
    signals: [
      {
        type: 'chainlock_conflict',
        fingerprint: 'ef0a97b51d4622a99a8d39b1',
        count: 4,
        firstSeenAt: '2026-07-12T09:20:00Z',
        lastSeenAt: '2026-07-12T09:21:00Z',
        peerIps: ['203.0.113.10'],
        sample: 'AcceptBlockHeader: block <hash> is marked conflicting',
      },
    ],
  };
}

describe('network noise v1 routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/network-noise', networkNoiseRoutes);

  beforeEach(() => {
    vi.clearAllMocks();
    config.networkNoise.enabled = true;
    config.networkNoise.ingestTokens = { 'node-a': TOKEN };
    mocks.ingest.mockResolvedValue({ duplicate: false, acceptedSignals: 1, noiseScore: 72 });
    mocks.getSummary.mockResolvedValue(summaryPayload());
  });

  it('accepts one authenticated telemetry batch', async () => {
    const response = await request(app)
      .post('/api/v1/network-noise/ingest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validPayload());

    expect(response.status).toBe(202);
    expect(response.body.success).toBe(true);
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid node token', async () => {
    const response = await request(app)
      .post('/api/v1/network-noise/ingest')
      .set('Authorization', 'Bearer invalid-token')
      .send(validPayload());

    expect(response.status).toBe(401);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('rejects malformed telemetry without calling the service', async () => {
    const response = await request(app)
      .post('/api/v1/network-noise/ingest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ ...validPayload(), sequence: -1 });

    expect(response.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('returns the stored summary', async () => {
    const response = await request(app).get('/api/v1/network-noise/summary?hours=24');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mocks.getSummary).toHaveBeenCalledWith(24);
  });

  it('accepts v2 PoSe data through the same per-node authentication', async () => {
    mocks.ingest.mockResolvedValue({ duplicate: false, acceptedSignals: 0, noiseScore: 0, acceptedPoseObservations: 1 });
    const response = await request(app).post('/api/v1/network-noise/ingest')
      .set('Authorization', `Bearer ${TOKEN}`).send(posePayload());
    expect(response.status).toBe(202);
    expect(response.body.data.acceptedPoseObservations).toBe(1);
    expect(mocks.ingest).toHaveBeenCalledWith(posePayload());
  });

  it('rejects malformed structured data and excessive samples before storage', async () => {
    const response = await request(app).post('/api/v1/network-noise/ingest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(posePayload({ poseEvents: [poseEvent({ eventBlockHash: 'not-a-hash' })] }));
    expect(response.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized structured batch', async () => {
    const response = await request(app).post('/api/v1/network-noise/ingest')
      .set('Authorization', 'Bearer wrong').send(posePayload());
    expect(response.status).toBe(401);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('keeps duplicate v2 batches at 200', async () => {
    mocks.ingest.mockResolvedValue({ duplicate: true, acceptedSignals: 0, noiseScore: 0, acceptedPoseObservations: 0 });
    const response = await request(app).post('/api/v1/network-noise/ingest')
      .set('Authorization', `Bearer ${TOKEN}`).send(posePayload());
    expect(response.status).toBe(200);
    expect(response.body.data.acceptedPoseObservations).toBe(0);
  });

  it('returns a conflict for a reused sequence with different content', async () => {
    mocks.ingest.mockRejectedValue(new NetworkNoiseSequenceConflict('Sequence already belongs to a different batch'));
    const response = await request(app).post('/api/v1/network-noise/ingest')
      .set('Authorization', `Bearer ${TOKEN}`).send(posePayload());
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SEQUENCE_CONFLICT');
  });

  it('returns paginated observed-only data with no cache', async () => {
    poseMocks.getEvents.mockResolvedValue({
      generatedAt: '2026-10-06T12:00:00Z', windowHours: 24, retentionDays: 365,
      page: 2, limit: 10, total: 0, observationCount: 0, uncorrelatedEvents: 0, chainVerifiedEvents: 0, events: [],
    });
    const response = await request(app).get('/api/v1/network-noise/pose-events?page=2&limit=10&quorumType=7');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(poseMocks.getEvents).toHaveBeenCalledWith({ hours: 24, page: 2, limit: 10, quorumType: 7 });
    expect(response.body.data.chainVerifiedEvents).toBe(0);
  });

  it.each(['limit=101', 'page=0', 'hours=8761', 'kind=invalid', 'quorumType=256', 'proTxHash=bad'])
    ('rejects an invalid PoSe event query: %s', async (query) => {
      const response = await request(app).get(`/api/v1/network-noise/pose-events?${query}`);
      expect(response.status).toBe(400);
      expect(poseMocks.getEvents).not.toHaveBeenCalled();
    });

  it('does not publish a falsely chain-verified service response', async () => {
    poseMocks.getEvents.mockResolvedValue({
      generatedAt: '2026-10-06T12:00:00Z', windowHours: 24, retentionDays: 365,
      page: 1, limit: 50, total: 0, observationCount: 0, uncorrelatedEvents: 0, chainVerifiedEvents: 1, events: [],
    });
    const response = await request(app).get('/api/v1/network-noise/pose-events');
    expect(response.status).toBe(500);
  });
});
