import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poseChainApiResponseSchema } from '@defcon/shared/dist/contracts';

const mocks = vi.hoisted(() => ({ getPoseChainData: vi.fn() }));
const nodeMocks = vi.hoisted(() => ({ getEnrichedNodes: vi.fn() }));
vi.mock('../src/services/poseChainQuery.service', () => mocks);
vi.mock('../src/services/masternode.service', () => nodeMocks);
vi.mock('../src/utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { config } from '../src/config';
import { PoseChainState } from '../src/models/PoseChainState';
import v1Routes from '../src/routes/v1';

// The real /api/v1 router, so that a route mounted behind a dynamic path fails here too.
const app = express();
app.use('/api/v1', v1Routes);
describe('PoSe canonical commitment route', () => {
  const originalPoseChain = { ...config.poseChain };
  afterEach(() => { Object.assign(config.poseChain, originalPoseChain); });
  beforeEach(() => {
    mocks.getPoseChainData.mockResolvedValue({
      generatedAt: new Date().toISOString(), status: 'disabled',
      coverage: { startHeight: 144888, lastHeight: 144887, lastHash: null, targetHeight: null,
        checkedAt: null, lastReorgAt: null, remainingBlocks: null, caughtUp: false, confirmedThroughHeight: 144887 },
      windowHours: 24, page: 1, limit: 10, total: 0, quorumSummary: [], commitments: [],
      penaltyCoverage: { enabled: false, commitmentBlocks: 0, verifiedBlocks: 0, pendingBlocks: 0,
        unavailableBlocks: 0, unsupportedBlocks: 0, inconsistentBlocks: 0, notApplicableBlocks: 0 },
    });
  });

  it('is mounted before the dynamic node route, which still serves other ids', async () => {
    nodeMocks.getEnrichedNodes.mockResolvedValue([]);
    expect((await request(app).get('/api/v1/masternodes/pose-chain')).status).toBe(200);
    expect(mocks.getPoseChainData).toHaveBeenCalledTimes(1);
    expect(nodeMocks.getEnrichedNodes).not.toHaveBeenCalled();

    const other = await request(app).get(`/api/v1/masternodes/${'a'.repeat(64)}`);
    expect(other.status).toBe(404);
    expect(other.body.error.message).toBe('Masternode not found');
    expect(nodeMocks.getEnrichedNodes).toHaveBeenCalledTimes(1);
    expect(mocks.getPoseChainData).toHaveBeenCalledTimes(1);
  });

  it('answers with the real service as disabled while the collector is off', async () => {
    const { getPoseChainData } = await vi.importActual<typeof import('../src/services/poseChainQuery.service')>(
      '../src/services/poseChainQuery.service');
    mocks.getPoseChainData.mockImplementationOnce(getPoseChainData);
    Object.assign(config.poseChain, { enabled: false, attributionEnabled: false });
    vi.spyOn(PoseChainState, 'findOne').mockReturnValue({ lean: async () => null } as never);

    const response = await request(app).get('/api/v1/masternodes/pose-chain').query({ hours: 24, limit: 1 });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(poseChainApiResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.data).toMatchObject({ status: 'disabled', total: 0, quorumSummary: [], commitments: [],
      penaltyCoverage: { enabled: false, commitmentBlocks: 0 }, coverage: { caughtUp: false, checkedAt: null } });
  });

  it('returns schema-checked no-store coverage and normalizes filters', async () => {
    const response = await request(app).get('/api/v1/masternodes/pose-chain')
      .query({ hours: 48, page: 2, limit: 1, quorumType: 7, proTxHash: 'A'.repeat(64) });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(poseChainApiResponseSchema.safeParse(response.body).success).toBe(true);
    expect(mocks.getPoseChainData).toHaveBeenCalledWith({ hours: 48, page: 2, limit: 1, quorumType: 7, proTxHash: 'a'.repeat(64) });
  });

  it('rejects invalid pagination, ranges and hashes before querying the store', async () => {
    for (const query of ['hours=0', 'hours=8761', 'page=0', 'limit=51', 'quorumType=256', 'proTxHash=bad',
      'since=bad', `since=${encodeURIComponent(new Date(Date.now() + 3600000).toISOString())}`,
      'fromHeight=-1', 'fromHeight=1.5', 'fromHeight=', 'fromHeight=9007199254740992']) {
      expect((await request(app).get(`/api/v1/masternodes/pose-chain?${query}`)).status).toBe(400);
    }
    expect(mocks.getPoseChainData).not.toHaveBeenCalled();
  });

  it('passes a selected history start and activation height to the canonical store', async () => {
    const since = new Date(Date.now() - 3600000).toISOString();
    const response = await request(app).get('/api/v1/masternodes/pose-chain').query({ since, fromHeight: 144888 });
    expect(response.status).toBe(200);
    expect(mocks.getPoseChainData).toHaveBeenCalledWith({ hours: 24, page: 1, limit: 10, since, fromHeight: 144888 });
  });

  it('does not publish malformed service output or internal failure details', async () => {
    mocks.getPoseChainData.mockResolvedValueOnce({ status: 'ready' });
    expect((await request(app).get('/api/v1/masternodes/pose-chain')).status).toBe(500);
    mocks.getPoseChainData.mockRejectedValueOnce(new Error('private-rpc-password'));
    const response = await request(app).get('/api/v1/masternodes/pose-chain');
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('private-rpc-password');
  });
});
