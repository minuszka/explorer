import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { attributedBlock, attributionNow, attributionQuery } from './fixtures/banAttribution';
import { chainHash } from './fixtures/poseChain';

const mocks = vi.hoisted(() => ({ state: vi.fn(), block: vi.fn(), observers: vi.fn() }));
vi.mock('../src/models/PoseChainState', () => ({ PoseChainState: { findOne: mocks.state } }));
vi.mock('../src/models/PoseChainBlock', () => ({ PoseChainBlock: { findOne: mocks.block } }));
vi.mock('../src/models/PoseObservation', () => ({ PoseObservation: { distinct: mocks.observers } }));
import { getBanAttribution } from '../src/services/banAttribution.service';

describe('BANNED_BY read safety', () => {
  const original = { ...config.poseChain };
  const state = { status: 'ready', startHeight: 100, lastHeight: 102, lastHash: chainHash(102), targetHeight: 102,
    revision: 1, checkedAt: attributionNow };
  const stateRead = (read: () => Promise<unknown>) => ({ maxTimeMS: () => ({ lean: read }) });
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(attributionNow);
    Object.assign(config.poseChain, { enabled: true, attributionEnabled: true });
    mocks.state.mockReturnValue(stateRead(async () => state));
    mocks.block.mockReturnValue({ lean: () => ({ maxTimeMS: async () => attributedBlock() }) });
    mocks.observers.mockReturnValue({ maxTimeMS: async () => ['observer-a', 'observer-b'] });
  });
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); Object.assign(config.poseChain, original); });
  it('queries only the exact canonical block and exact observer anchor', async () => {
    const data = await getBanAttribution(attributionQuery);
    expect(data).toMatchObject({ status: 'verified', proof: { observerCount: 2, blockHeight: 100 } });
    expect(data.message).toContain('Q60/41');
    expect(mocks.block).toHaveBeenCalledWith({ canonical: true, height: 100 });
    expect(mocks.observers.mock.calls[0]).toEqual(['nodeId', {
      eventBlockHash: chainHash(100), eventBlockHeight: 100, quorumType: 7, quorumHash: chainHash(900), proTxHash: chainHash(2),
      expiresAt: { $gt: attributionNow }, eventAt: { $lte: attributionNow }, observedAt: { $lte: attributionNow },
      kind: { $in: ['penalty_change', 'ban', 'dkg_member'] },
    }]);
  });
  it.each(['disabled', 'unavailable', 'collecting', 'stale', 'future', 'attribution_disabled', 'before', 'after'])(
    'does not read evidence with %s coverage', async (scenario) => {
      if (scenario === 'disabled') config.poseChain.enabled = false;
      if (scenario === 'attribution_disabled') config.poseChain.attributionEnabled = false;
      if (scenario === 'unavailable') mocks.state.mockReturnValue(stateRead(async () => null));
      if (scenario === 'collecting') mocks.state.mockReturnValue(stateRead(async () => ({ ...state, status: 'collecting' })));
      if (scenario === 'stale' || scenario === 'future') mocks.state.mockReturnValue(stateRead(async () => ({ ...state,
        checkedAt: new Date(attributionNow.getTime() + (scenario === 'future' ? 1 : -3600000)) })));
      const query = { ...attributionQuery, banHeight: scenario === 'before' ? 99 : scenario === 'after' ? 103 : 100 };
      expect(await getBanAttribution(query)).toMatchObject({ status: 'unknown', proof: null });
      expect(mocks.block).not.toHaveBeenCalled(); expect(mocks.observers).not.toHaveBeenCalled();
    });
  it.each(['pending', 'state_unavailable', 'unsupported_context', 'inconsistent', 'not_applicable', 'missing', 'hash'])(
    'retains %s as unknown instead of converting membership or log reports into a ban', async (gap) => {
      const block = attributedBlock();
      const value = gap === 'missing' ? null : { ...block, penaltyAttribution: gap === 'pending' ? null
        : gap === 'hash' ? block.penaltyAttribution : { ...block.penaltyAttribution, status: gap } };
      mocks.block.mockReturnValue({ lean: () => ({ maxTimeMS: async () => value }) });
      const data = await getBanAttribution({ ...attributionQuery, ...(gap === 'hash' ? { blockHash: chainHash(999) } : {}) });
      expect(data).toMatchObject({ status: 'unknown', proof: null, reason: gap === 'missing' ? 'block_unavailable'
        : gap === 'hash' ? 'block_hash_mismatch' : gap });
      expect(mocks.observers).not.toHaveBeenCalled();
    });
  it.each(['revision', 'status', 'target', 'expiry', 'disable'])(
    'retracts evidence if %s changes while reading', async (change) => {
      mocks.state.mockReturnValueOnce(stateRead(async () => state)).mockReturnValueOnce(stateRead(async () => {
        if (change === 'expiry') vi.setSystemTime(attributionNow.getTime() + 3600000);
        if (change === 'disable') config.poseChain.attributionEnabled = false;
        return { ...state, ...(change === 'revision' ? { revision: 2 } : change === 'status' ? { status: 'collecting' }
          : change === 'target' ? { targetHeight: 99 } : {}) };
      }));
      expect(await getBanAttribution(attributionQuery)).toMatchObject({ status: 'unknown', reason: 'read_invalidated', proof: null });
    });
});
