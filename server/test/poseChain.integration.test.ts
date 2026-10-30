import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { poseChainDataSchema, poseChainQuerySchema, banAttributionDataSchema } from '@defcon/shared/dist/contracts';
import { config } from '../src/config';
import { PoseChainBlock } from '../src/models/PoseChainBlock';
import { PoseChainState } from '../src/models/PoseChainState';
import { PoseObservation } from '../src/models/PoseObservation';
import { NetworkNoiseNodeState } from '../src/models/NetworkNoiseNodeState';
import { NetworkNoiseObservation } from '../src/models/NetworkNoiseObservation';
import { NetworkNoiseBaseline, NetworkNoiseBatch } from '../src/models/NetworkNoiseBatch';
import { networkNoiseService } from '../src/services/networkNoise.service';
import { PoseChainService } from '../src/services/poseChain.service';
import { getPoseChainData } from '../src/services/poseChainQuery.service';
import { getBanAttribution } from '../src/services/banAttribution.service';
import { poseTelemetryService } from '../src/services/poseTelemetry.service';
import { chainHash, commitmentPayload } from './fixtures/poseChain';
import { poseEvent, posePayload } from './fixtures/poseTelemetry';
import mined from './fixtures/pose-chain-v23.json';

const baseUri = process.env.TEST_POSE_MONGO_URI;
describe.skipIf(!baseUri)('canonical PoSe collection with disposable MongoDB', () => {
  const originalConfig = { ...config.poseChain };
  type Tx = { txid: string; type?: number; extraPayload?: string; vin?: { coinbase?: string }[] };
  type Block = { hash: string; height: number; previousblockhash: string; time: number; tx: Tx[] };
  let blocks: Map<number, Block>;
  let tip: number;
  let failMembership: boolean;
  let hook: ((method: string, params: unknown[]) => Promise<void> | void) | undefined;
  let rpc: { call: ReturnType<typeof vi.fn> };
  let service: PoseChainService;
  const query = (overrides = {}) => poseChainQuerySchema.parse(overrides);

  beforeAll(async () => {
    if (!baseUri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/deftrack_pose_test_[a-f0-9]+$/.test(baseUri)) {
      throw new Error('TEST_POSE_MONGO_URI must name an isolated localhost test database');
    }
    // Different database from the telemetry suite, which can run concurrently.
    await mongoose.connect(`${baseUri}c1`, { serverSelectionTimeoutMS: 5000 });
    await Promise.all([PoseChainBlock.init(), PoseChainState.init(), PoseObservation.init(), NetworkNoiseNodeState.init(), NetworkNoiseObservation.init()]);
  });
  afterAll(async () => {
    Object.assign(config.poseChain, originalConfig);
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  function block(height: number, branch = 0, withCommitment = true): Block {
    return { hash: chainHash(height + branch * 1000), height,
      previousblockhash: blocks?.get(height - 1)?.hash ?? chainHash(height - 1),
      time: Math.floor(Date.now() / 1000) - (110 - height) * 60,
      tx: withCommitment ? [{ txid: chainHash(height + branch * 1000 + 10000), type: 6,
        extraPayload: commitmentPayload({ height, quorumHash: chainHash(height + 900) }) }] : [],
    };
  }
  beforeEach(async () => {
    await Promise.all([PoseChainBlock.deleteMany({}), PoseChainState.deleteMany({}), PoseObservation.deleteMany({}), NetworkNoiseNodeState.deleteMany({}), NetworkNoiseObservation.deleteMany({}), NetworkNoiseBaseline.deleteMany({}), NetworkNoiseBatch.deleteMany({})]);
    Object.assign(config.poseChain, { enabled: true, startHeight: 100, blocksPerRun: 10,
      confirmations: 1, reorgMaxDepth: 5, membershipRetryBlocks: 5, attributionEnabled: false, attributionBlocksPerRun: 5 });
    blocks = new Map(); tip = 102; failMembership = false; hook = undefined;
    for (let height = 100; height <= tip; height++) blocks.set(height, block(height));
    rpc = { call: vi.fn(async (method: string, params: unknown[] = []) => {
      await hook?.(method, params);
      if (method === 'getblockchaininfo') return { chain: 'main', blocks: tip };
      if (method === 'getnetworkinfo') return mined.network;
      if (method === 'getblockhash') {
        const found = blocks.get(params[0] as number);
        if (!found) throw new Error('Missing block');
        return found.hash;
      }
      if (method === 'getblock') return [...blocks.values()].find((entry) => entry.hash === params[0]);
      if (method === 'quorum') {
        if (failMembership) throw new Error('quorum not found with private daemon config');
        const height = Number.parseInt(params[2] as string, 16) - 900;
        return { quorumHash: params[2], minedBlock: blocks.get(height)?.hash, quorumIndex: 0,
          members: [{ proTxHash: chainHash(1), valid: true }, { proTxHash: chainHash(2), valid: false }] };
      }
      throw new Error(`Unexpected RPC ${method}`);
    }) };
    service = new PoseChainService(rpc as { call<T>(method: string, params?: unknown[]): Promise<T> });
  });

  it('backfills a contiguous bounded prefix including empty blocks and is idempotent', async () => {
    blocks.set(101, block(101, 0, false)); config.poseChain.blocksPerRun = 2;
    await service.collectOnce();
    expect(await PoseChainState.findOne().lean()).toMatchObject({ lastHeight: 101, status: 'ready' });
    expect((await getPoseChainData(query())).coverage).toMatchObject({ remainingBlocks: 1, caughtUp: false });
    await service.collectOnce(); await service.collectOnce();
    const data = await getPoseChainData(query());
    expect(data).toMatchObject({ status: 'ready', total: 2, coverage: { lastHeight: 102, remainingBlocks: 0, caughtUp: true } });
    expect(data.quorumSummary[0]).toMatchObject({ participants: 4, invalidMembers: 2 });
    expect(await PoseChainBlock.countDocuments()).toBe(3);
    expect(poseChainDataSchema.safeParse(data).success).toBe(true);
  });

  it('retracts the old branch, replays replacements and retains fork evidence', async () => {
    await service.collectOnce();
    await poseTelemetryService.ingest(posePayload({ poseEvents: [poseEvent({
      eventAt: new Date(Date.now() - 60000).toISOString(), eventBlockHash: chainHash(102), eventBlockHeight: 102,
      quorumType: 7, quorumHash: chainHash(1002), proTxHash: chainHash(2),
    })] }));
    expect((await getPoseChainData(query())).commitments[0].observerCount).toBe(1);
    blocks.set(101, block(101, 1)); blocks.set(102, block(102, 1));
    await service.collectOnce();
    expect(await PoseChainBlock.countDocuments({ canonical: true })).toBe(3);
    expect(await PoseChainBlock.countDocuments({ canonical: false })).toBe(2);
    const data = await getPoseChainData(query());
    expect(data.commitments.map((entry) => entry.blockHash)).toEqual([chainHash(1102), chainHash(1101), chainHash(100)]);
    expect(data.coverage.lastReorgAt).not.toBeNull();
    expect(data.commitments[0].observerCount).toBe(0);
    expect(await PoseObservation.countDocuments()).toBe(1);
  });

  it('replays mixed v1/v2 reports across a reorg and stale coverage', async () => {
    await service.collectOnce();
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString();
    const event = poseEvent({ eventAt: recent, eventBlockHash: chainHash(102), eventBlockHeight: 102,
      quorumType: 7, quorumHash: chainHash(1002), proTxHash: chainHash(2) });
    const newer = posePayload({ nodeId: 'mixed-a', observedAt: recent, sequence: 12, poseEvents: [event] });
    const { poseEvents: _events, ...common } = newer;
    const legacy = { ...common, schemaVersion: 1 as const, sequence: 11,
      signals: [{ type: 'mixed_signal', fingerprint: 'mixed-fingerprint', count: 1,
        firstSeenAt: recent, lastSeenAt: recent }] };
    expect((await networkNoiseService.ingest(legacy)).duplicate).toBe(false);
    expect((await networkNoiseService.ingest(newer)).acceptedPoseObservations).toBe(1);
    expect((await networkNoiseService.ingest(newer)).duplicate).toBe(true);
    expect((await networkNoiseService.ingest({ ...newer, sequence: 13 })).acceptedPoseObservations).toBe(0);
    expect((await networkNoiseService.ingest({ ...newer, nodeId: 'mixed-b' })).acceptedPoseObservations).toBe(1);
    expect(await NetworkNoiseObservation.countDocuments()).toBe(1);
    expect(await PoseObservation.countDocuments()).toBe(2);
    expect((await getPoseChainData(query())).commitments.find((entry) => entry.blockHeight === 102))
      .toMatchObject({ blockHash: chainHash(102), observerCount: 2 });

    await PoseChainState.updateOne({}, { $set: { checkedAt: new Date(0) } });
    expect(await getPoseChainData(query())).toMatchObject({ status: 'stale', total: 0, commitments: [] });
    blocks.set(101, block(101, 1)); blocks.set(102, block(102, 1));
    await service.collectOnce();
    const after = await getPoseChainData(query());
    expect(after.status).toBe('ready');
    expect(after.commitments.find((entry) => entry.blockHeight === 102))
      .toMatchObject({ blockHash: chainHash(1102), observerCount: 0 });
    const observations = await poseTelemetryService.getEvents({ hours: 24, page: 1, limit: 50 });
    expect(observations.events[0]).toMatchObject({ observerCount: 2, canonicalStatus: 'unverified' });
    expect(await PoseChainBlock.countDocuments({ canonical: false })).toBe(2);
  });

  it('fails closed on deep reorg, and can recover after increasing the allowed depth', async () => {
    await service.collectOnce(); config.poseChain.reorgMaxDepth = 1;
    for (let height = 100; height <= tip; height++) blocks.set(height, block(height, 1));
    await expect(service.collectOnce()).rejects.toThrow(/depth/);
    expect(await getPoseChainData(query())).toMatchObject({ status: 'unavailable', total: 0, commitments: [] });
    config.poseChain.reorgMaxDepth = 5;
    await service.collectOnce();
    expect((await getPoseChainData(query())).total).toBe(3);
  });

  it('handles a shorter active chain without publishing removed heights', async () => {
    await service.collectOnce(); tip = 100;
    await service.collectOnce();
    expect(await PoseChainBlock.countDocuments({ canonical: true })).toBe(1);
    expect(await getPoseChainData(query())).toMatchObject({ total: 1, coverage: { lastHeight: 100 } });
  });

  it('preserves raw payloads and retries unavailable membership without advancing the checkpoint', async () => {
    failMembership = true; await service.collectOnce();
    let data = await getPoseChainData(query());
    expect(data.quorumSummary[0]).toMatchObject({ unavailableCommitments: 3, verifiedCommitments: 0, participants: 0 });
    expect(data.commitments[0]).toMatchObject({ evidence: 'unknown', memberSlots: 2, invalidSlots: 1 });
    const stored = await PoseChainBlock.findOne({ height: 100 }).lean();
    expect(stored?.commitments[0].rawPayload).toBe(blocks.get(100)?.tx[0].extraPayload);
    failMembership = false; config.poseChain.membershipRetryBlocks = 1;
    await service.collectOnce(); data = await getPoseChainData(query());
    expect(data.quorumSummary[0]).toMatchObject({ unavailableCommitments: 2, verifiedCommitments: 1 });
    await service.collectOnce(); await service.collectOnce();
    expect((await getPoseChainData(query())).quorumSummary[0]).toMatchObject({ verifiedCommitments: 3 });
    expect(await PoseChainState.findOne().lean()).toMatchObject({ lastHeight: 102 });
  });

  it('processes every commitment independently, including null and unsupported payloads', async () => {
    const first = blocks.get(100)!;
    first.tx.push({ txid: chainHash(20000), type: 6, extraPayload: commitmentPayload({ height: 100, isNull: true }) },
      { txid: chainHash(20001), type: 6, extraPayload: commitmentPayload({ height: 100, payloadVersion: 2 }) },
      { txid: chainHash(20002), type: 6, extraPayload: commitmentPayload({ height: 100, quorumType: 3 }) });
    hook = (method, params) => { if (method === 'quorum' && params[1] === 3) throw new Error('quorum not found'); };
    await service.collectOnce();
    const data = await getPoseChainData(query());
    expect(data.total).toBe(6);
    expect(data.commitments.map((entry) => entry.membershipStatus).sort()).toEqual(
      ['membership_unavailable', 'null', 'unsupported_payload', 'verified', 'verified', 'verified']);
    expect(data.quorumSummary.reduce((sum, item) => sum + item.invalidMembers, 0)).toBe(3);
  });

  it('recovers a block written beyond the checkpoint after a storage failure', async () => {
    const update = PoseChainState.updateOne.bind(PoseChainState);
    let failed = false;
    vi.spyOn(PoseChainState, 'updateOne').mockImplementation(((filter: any, change: any, options: any) => {
      if (!failed && change.$set?.lastHeight === 102) { failed = true; throw new Error('storage failed'); }
      return update(filter, change, options);
    }) as any);
    await expect(service.collectOnce()).rejects.toThrow(/storage failed/);
    expect(await PoseChainState.findOne().lean()).toMatchObject({ lastHeight: 101, status: 'error' });
    expect((await getPoseChainData(query())).total).toBe(0);
    await service.collectOnce();
    expect(await PoseChainBlock.countDocuments()).toBe(3);
    expect((await getPoseChainData(query())).total).toBe(3);
  });

  it('detects a reorg during RPC before publishing a block', async () => {
    hook = (method, params) => { if (method === 'quorum' && params[2] === chainHash(1000)) blocks.set(100, block(100, 1)); };
    await expect(service.collectOnce()).rejects.toThrow(/reorganized/);
    expect(await PoseChainState.findOne().lean()).toMatchObject({ lastHeight: 99, status: 'error' });
    expect(await PoseChainBlock.countDocuments({ canonical: true })).toBe(0);
  });

  it('rejects missing payloads, txid-only blocks, wrong parents and mismatched payload heights', async () => {
    blocks.get(100)!.tx[0].extraPayload = undefined;
    await expect(service.collectOnce()).rejects.toThrow(/payload/);
    blocks.get(100)!.tx = [chainHash(10000)] as any;
    await expect(service.collectOnce()).rejects.toThrow();
    blocks.set(100, block(100));
    blocks.get(101)!.previousblockhash = chainHash(42);
    await expect(service.collectOnce()).rejects.toThrow(/parent/);
    blocks.get(101)!.previousblockhash = chainHash(100);
    blocks.get(101)!.tx[0].extraPayload = commitmentPayload({ height: 99 });
    await expect(service.collectOnce()).rejects.toThrow(/height/);
    expect((await getPoseChainData(query())).total).toBe(0);
  });

  it('publishes only confirmed heights and clamps low-chain targets', async () => {
    config.poseChain.confirmations = 3; await service.collectOnce();
    expect((await getPoseChainData(query())).coverage).toMatchObject({ lastHeight: 100, targetHeight: 100 });
    config.poseChain.confirmations = 4; await service.collectOnce();
    expect(await getPoseChainData(query())).toMatchObject({ total: 0, coverage: { confirmedThroughHeight: 99 } });
    tip = 0; config.poseChain.reorgMaxDepth = 5;
    await service.collectOnce();
    expect((await getPoseChainData(query())).coverage.targetHeight).toBe(0);
  });

  it('links exact observer anchors once per node, keeps observations unverified and supports filtering', async () => {
    await service.collectOnce();
    const event = poseEvent({ eventAt: new Date(Date.now() - 60000).toISOString(), eventBlockHash: chainHash(102),
      eventBlockHeight: 102, quorumType: 7, quorumHash: chainHash(1002), proTxHash: chainHash(2) });
    for (let i = 0; i < 12; i++) await poseTelemetryService.ingest(posePayload({ nodeId: `node-${i}`, poseEvents: [event] }));
    await poseTelemetryService.ingest(posePayload({ nodeId: 'node-0', sequence: 99,
      poseEvents: [{ ...event, eventId: 'other-score', penalty: 99 }] }));
    for (const [i, overrides] of [{ eventBlockHeight: 101 }, { eventBlockHash: chainHash(1102) },
      { quorumType: 2 }, { quorumHash: chainHash(42) }, { proTxHash: chainHash(3) },
      { eventAt: new Date(Date.now() + 60000).toISOString() }].entries()) {
      await poseTelemetryService.ingest(posePayload({ nodeId: `wrong-${i}`, poseEvents: [{ ...event, ...overrides }] }));
    }
    await poseTelemetryService.ingest(posePayload({ nodeId: 'future-report',
      observedAt: new Date(Date.now() + 3600000).toISOString(), poseEvents: [event] }));
    const data = await getPoseChainData(query({ limit: 1, proTxHash: chainHash(2), quorumType: 7 }));
    expect(data).toMatchObject({ total: 3, commitments: [{ observerCount: 12, invalidMemberCount: 1 }] });
    expect(data.commitments[0].members[1].observerCount).toBe(12);
    expect((await getPoseChainData(query({ page: 2, limit: 1 }))).commitments[0].blockHeight).toBe(101);
    expect((await getPoseChainData(query({ quorumType: 2 }))).total).toBe(0);
    expect(await PoseObservation.countDocuments()).toBe(20);
    await PoseObservation.updateOne({ nodeId: 'future-report' }, { $set: { observedAt: new Date(Date.now() - 1000) } });
    const recovered = await getPoseChainData(query({ limit: 1, proTxHash: chainHash(2), quorumType: 7 }));
    expect(recovered.commitments[0]).toMatchObject({ observerCount: 13 });
    expect(recovered.commitments[0].members[1].observerCount).toBe(13);
  });

  it('excludes observers that expire while reading commitment and member counts', async () => {
    await service.collectOnce();
    const now = Date.now();
    const event = poseEvent({ eventAt: new Date(now - 60000).toISOString(), eventBlockHash: chainHash(102),
      eventBlockHeight: 102, quorumType: 7, quorumHash: chainHash(1002), proTxHash: chainHash(2) });
    await poseTelemetryService.ingest(posePayload({ nodeId: 'short-lived', poseEvents: [event] }));
    await poseTelemetryService.ingest(posePayload({ nodeId: 'still-valid', poseEvents: [event] }));
    await poseTelemetryService.ingest(posePayload({ nodeId: 'still-valid',
      poseEvents: [{ ...event, eventId: 'other-score', penalty: 99 }] }));
    await PoseObservation.updateMany({ nodeId: 'short-lived' }, { $set: { expiresAt: new Date(now + 1000) } });
    await PoseObservation.updateOne({ nodeId: 'still-valid', penalty: 145 }, { $set: { expiresAt: new Date(now + 1000) } });
    const findOne = PoseChainState.findOne.bind(PoseChainState);
    let calls = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    const spy = vi.spyOn(PoseChainState, 'findOne').mockImplementation(((...args: Parameters<typeof findOne>) => {
      calls++;
      if (calls === 2) vi.setSystemTime(now + 2000);
      return findOne(...args);
    }) as typeof PoseChainState.findOne);
    try {
      const data = await getPoseChainData(query({ limit: 1, proTxHash: chainHash(2), quorumType: 7 }));
      expect(data).toMatchObject({ status: 'ready', total: 3, commitments: [{ observerCount: 1 }] });
      expect(data.commitments[0].members[1].observerCount).toBe(1);
      expect(poseChainDataSchema.safeParse(data).success).toBe(true);
    } finally {
      spy.mockRestore(); vi.useRealTimers();
    }
  });

  it('does not serve attribution when disabled, stale, collecting or errored', async () => {
    expect(await getPoseChainData(query())).toMatchObject({ status: 'unavailable', total: 0 });
    await service.collectOnce();
    config.poseChain.enabled = false;
    expect(await getPoseChainData(query())).toMatchObject({ status: 'disabled', total: 0 });
    config.poseChain.enabled = true;
    await PoseChainState.updateOne({}, { $set: { checkedAt: new Date(Date.now() - 3600000) } });
    expect(await getPoseChainData(query())).toMatchObject({ status: 'stale', total: 0 });
    for (const status of ['collecting', 'error']) {
      await PoseChainState.updateOne({}, { $set: { status, checkedAt: new Date() } });
      expect((await getPoseChainData(query())).total).toBe(0);
    }
  });

  it('detects an ABA collection during a query even when checkpoint and timestamp are unchanged', async () => {
    await service.collectOnce();
    const aggregate = PoseChainBlock.aggregate.bind(PoseChainBlock);
    vi.spyOn(PoseChainBlock, 'aggregate').mockImplementation(((pipeline: any) => ({ option: async (options: any) => {
      const result = await aggregate(pipeline).option(options);
      await PoseChainState.updateOne({}, { $inc: { revision: 1 } });
      return result;
    } })) as any);
    expect(await getPoseChainData(query())).toMatchObject({ status: 'collecting', total: 0, commitments: [] });
  });

  it('coalesces concurrent collection calls and awaits collection during stop', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    hook = async (method) => { if (method === 'getblockchaininfo') await wait; };
    const first = service.collectOnce(); const second = service.collectOnce(); const stopped = service.stop();
    release(); await Promise.all([first, second, stopped]);
    expect(rpc.call.mock.calls.filter(([method]) => method === 'getblockchaininfo')).toHaveLength(1);
    expect(await PoseChainBlock.countDocuments()).toBe(3);
  });

  it('replays real v23 commitments without equating unused slots with invalid members', async () => {
    const real = mined.blocks[0];
    blocks = new Map([[real.height, real]]); tip = real.height; config.poseChain.startHeight = real.height;
    rpc.call.mockImplementation(async (method: string, params: unknown[] = []) => {
      if (method === 'getnetworkinfo') return mined.network;
      if (method === 'getblockchaininfo') return { chain: 'main', blocks: tip };
      if (method === 'getblockhash') return real.hash;
      if (method === 'getblock') return real;
      if (method === 'quorum') { expect(params[3]).toBe(false); return real.tx[0].quorumInfo; }
      throw new Error('Unexpected RPC');
    });
    await service.collectOnce();
    expect((await getPoseChainData(query({ hours: 8760 }))).commitments[0]).toMatchObject({
      evidence: 'chain_verified_membership', participantCount: 161, invalidMemberCount: 2, memberSlots: 400, invalidSlots: 241,
    });
  });

  it('rejects a different configured start, unsupported daemon and a non-main chain', async () => {
    await service.collectOnce(); config.poseChain.startHeight = 101;
    await expect(service.collectOnce()).rejects.toThrow(/start height/);
    config.poseChain.startHeight = 100;
    rpc.call.mockImplementation(async (method: string) => method === 'getblockchaininfo'
      ? { chain: 'test', blocks: 102 } : { version: 220104, subversion: '/DeFCoN:22.1.4/' });
    await expect(service.collectOnce()).rejects.toThrow();
    rpc.call.mockImplementation(async (method: string) => method === 'getblockchaininfo'
      ? { chain: 'main', blocks: 102 } : { version: 220104, subversion: '/DeFCoN:22.1.4/' });
    await expect(service.collectOnce()).rejects.toThrow();
    expect(await PoseChainState.findOne().lean()).toMatchObject({ error: 'Chain collection or validation failed' });
  });

  it('detects reorg during persistence and safely replays the unwritten checkpoint', async () => {
    const update = PoseChainBlock.updateOne.bind(PoseChainBlock);
    let changed = false;
    vi.spyOn(PoseChainBlock, 'updateOne').mockImplementation((async (filter: any, change: any, options: any) => {
      const result = await update(filter, change, options);
      if (!changed && change.$set?.canonical === false && change.$set?.height === 100) {
        changed = true;
        for (let height = 100; height <= tip; height++) blocks.set(height, block(height, 1));
      }
      return result;
    }) as any);
    await expect(service.collectOnce()).rejects.toThrow(/persistence/);
    expect(await PoseChainBlock.countDocuments({ canonical: true })).toBe(0);
    await service.collectOnce();
    expect((await getPoseChainData(query())).commitments.map((entry) => entry.blockHash))
      .toEqual([chainHash(1102), chainHash(1101), chainHash(1100)]);
  });

  it('recovers a crash between branch retraction and checkpoint rollback', async () => {
    await service.collectOnce();
    blocks.set(101, block(101, 1)); blocks.set(102, block(102, 1));
    const update = PoseChainState.updateOne.bind(PoseChainState);
    let failed = false;
    vi.spyOn(PoseChainState, 'updateOne').mockImplementation(((filter: any, change: any, options: any) => {
      if (!failed && change.$set?.lastReorgAt) { failed = true; throw new Error('rollback crash'); }
      return update(filter, change, options);
    }) as any);
    await expect(service.collectOnce()).rejects.toThrow(/rollback crash/);
    expect(await PoseChainBlock.countDocuments({ canonical: true })).toBe(1);
    await service.collectOnce();
    expect((await getPoseChainData(query())).commitments.map((entry) => entry.blockHash))
      .toEqual([chainHash(1102), chainHash(1101), chainHash(100)]);
  });

  it('hides evidence when the final canonicality recheck fails, then rolls back', async () => {
    await service.collectOnce();
    let checkpointReads = 0;
    hook = (method, params) => {
      if (method === 'getblockhash' && params[0] === 102 && ++checkpointReads === 2) blocks.set(102, block(102, 1));
    };
    await expect(service.collectOnce()).rejects.toThrow(/publication/);
    expect(await getPoseChainData(query())).toMatchObject({ status: 'unavailable', total: 0 });
    hook = undefined; await service.collectOnce();
    expect((await getPoseChainData(query())).commitments[0].blockHash).toBe(chainHash(1102));
  });

  it('does not promote mismatching membership and enforces one canonical block per height', async () => {
    hook = (method) => { if (method === 'quorum') throw new Error('temporarily missing'); };
    await service.collectOnce();
    const stored = await PoseChainBlock.findOne({ height: 100 }).lean();
    await expect(PoseChainBlock.create({ ...stored, _id: undefined, hash: chainHash(1100) })).rejects.toThrow(/duplicate key/);
    const original = rpc.call.getMockImplementation()!;
    rpc.call.mockImplementation(async (method: string, params: unknown[] = []) => method === 'quorum'
      ? { quorumHash: params[2], minedBlock: chainHash(42), quorumIndex: 0,
        members: [{ proTxHash: chainHash(1), valid: true }, { proTxHash: chainHash(2), valid: false }] }
      : original(method, params));
    hook = undefined; await service.collectOnce();
    expect((await getPoseChainData(query())).quorumSummary[0]).toMatchObject({ verifiedCommitments: 0, unavailableCommitments: 3 });
  });

  function enablePenaltyEvidence(enabled = true) {
    config.poseChain.attributionEnabled = enabled;
    const states = new Map<string, { height: number; penalty: number; banHeight: number }>();
    states.set(chainHash(99), { height: 99, penalty: 35, banHeight: -1 });
    for (const entry of blocks.values()) {
      entry.tx.unshift({ txid: chainHash(entry.height + 60000), type: 5, vin: [{ coinbase: '01' }] });
      states.set(entry.hash, { height: entry.height, penalty: 100, banHeight: 100 });
    }
    const original = rpc.call.getMockImplementation()!;
    rpc.call.mockImplementation(async (method: string, params: unknown[] = []) => {
      if (method === 'getblockhash' && params[0] === 0) return chainHash(0);
      if (method === 'protx') {
        await hook?.(method, params);
        expect(params[0]).toBe('listdiff'); expect(params[1]).toBe(chainHash(0));
        expect(typeof params[2]).toBe('string');
        const entry = states.get(params[2] as string);
        if (!entry) throw new Error('historical state not found');
        return { baseHeight: 0, blockHeight: entry.height, removedMNs: [], updatedMNs: [],
          addedMNs: [1, 2].map((id) => ({ proTxHash: chainHash(id),
            state: { PoSePenalty: id === 1 ? 0 : entry.penalty, PoSeBanHeight: id === 1 ? -1 : entry.banHeight,
              PoSeRevivedHeight: -1, dslBanHeight: -1, service: 'not-stored', pubKeyOperator: 'not-stored' } })) };
      }
      return original(method, params);
    });
    return states;
  }

  it('collects hash-addressed PoSe state and publishes exact punishment and ban evidence', async () => {
    enablePenaltyEvidence(); await service.collectOnce();
    const data = await getPoseChainData(query());
    expect(data.penaltyCoverage).toMatchObject({ enabled: true, commitmentBlocks: 3, verifiedBlocks: 3 });
    expect(data.quorumSummary[0]).toMatchObject({ penaltyApplications: 3, newBans: 1, unknownPenaltyCommitments: 0 });
    const member = data.commitments.find((item) => item.blockHeight === 100)!.members[1];
    expect(member).toMatchObject({ penaltyEvidence: 'chain_verified_penalty', penalty: {
      previousBlockPenalty: 35, beforePenalty: 34, afterPenalty: 100, appliedDelta: 66, banHeight: 100, causedBan: true,
    } });
    expect(data.commitments[0].members[1].penalty).toMatchObject({ appliedDelta: 0, causedBan: false });
    expect(poseChainDataSchema.safeParse(data).success).toBe(true);
    const stored = await PoseChainBlock.findOne({ height: 100 }).lean();
    expect(JSON.stringify(stored?.penaltyAttribution)).not.toContain('not-stored');
    expect(stored?.penaltyAttribution?.before).toHaveLength(2);
    const malformed = structuredClone(data);
    malformed.commitments[0].members[1].penalty!.appliedDelta = 999;
    expect(poseChainDataSchema.safeParse(malformed).success).toBe(false);
  });

  it('keeps verified bans and coverage inside the selected time and activation-height window', async () => {
    enablePenaltyEvidence(); await service.collectOnce();
    const since = new Date(blocks.get(101)!.time * 1000).toISOString();
    const timed = await getPoseChainData(query({ since }));
    expect(timed).toMatchObject({ total: 2, penaltyCoverage: { commitmentBlocks: 2, verifiedBlocks: 2 } });
    expect(timed.quorumSummary[0]).toMatchObject({ penaltyApplications: 2, newBans: 0 });
    expect(timed.commitments.map((row) => row.blockHeight)).toEqual([102, 101]);
    const activation = await getPoseChainData(query({ fromHeight: 102 }));
    expect(activation).toMatchObject({ total: 1, penaltyCoverage: { commitmentBlocks: 1, verifiedBlocks: 1 } });
    expect(activation.quorumSummary[0].newBans).toBe(0);
    const empty = await getPoseChainData(query({ fromHeight: 103 }));
    expect(empty).toMatchObject({ total: 0, quorumSummary: [], penaltyCoverage: { commitmentBlocks: 0, verifiedBlocks: 0 } });
  });

  it('backfills old commitment-only records with a separate bounded scoring budget', async () => {
    enablePenaltyEvidence(false); await service.collectOnce();
    expect(rpc.call.mock.calls.some(([method]) => method === 'protx')).toBe(false);
    await PoseChainBlock.updateMany({}, { $unset: { transactionTypes: '', penaltyAttribution: '' } });
    config.poseChain.attributionEnabled = true; config.poseChain.attributionBlocksPerRun = 1;
    await service.collectOnce();
    let data = await getPoseChainData(query());
    expect(data.coverage.caughtUp).toBe(true);
    expect(data.penaltyCoverage).toMatchObject({ verifiedBlocks: 1, pendingBlocks: 2 });
    expect(data.commitments[0].penaltyAttributionStatus).toBe('pending');
    await service.collectOnce(); await service.collectOnce();
    data = await getPoseChainData(query());
    expect(data.penaltyCoverage).toMatchObject({ verifiedBlocks: 3, pendingBlocks: 0 });
    config.poseChain.attributionEnabled = false;
    const disabled = await getPoseChainData(query());
    expect(disabled.commitments[0].members[1]).toMatchObject({ penaltyEvidence: 'unknown', penalty: null });
    expect(disabled.quorumSummary[0]).toMatchObject({ penaltyApplications: 0, newBans: 0 });
  });

  it('keeps missing historical state unknown and retries fairly after RPC recovery', async () => {
    enablePenaltyEvidence();
    hook = (method) => { if (method === 'protx') throw new Error('pruned state private details'); };
    await service.collectOnce();
    let data = await getPoseChainData(query());
    expect(data).toMatchObject({ status: 'ready', penaltyCoverage: { unavailableBlocks: 3 } });
    expect(data.quorumSummary[0]).toMatchObject({ newBans: 0, unknownPenaltyCommitments: 3 });
    expect(data.commitments[0].members[1]).toMatchObject({ penaltyEvidence: 'unknown', penalty: null });
    hook = undefined; await service.collectOnce(); data = await getPoseChainData(query());
    expect(data.penaltyCoverage).toMatchObject({ verifiedBlocks: 3, unavailableBlocks: 0 });
  });

  it('rejects incomplete block context and ambiguous provider transactions without state RPC claims', async () => {
    config.poseChain.attributionEnabled = true; await service.collectOnce();
    expect((await getPoseChainData(query())).penaltyCoverage.unsupportedBlocks).toBe(3);
    expect(rpc.call.mock.calls.some(([method]) => method === 'protx')).toBe(false);
    await PoseChainBlock.deleteMany({}); await PoseChainState.deleteMany({});
    enablePenaltyEvidence();
    for (const entry of blocks.values()) entry.tx.push({ txid: chainHash(80000 + entry.height), type: 2, extraPayload: '00' });
    await service.collectOnce();
    expect((await getPoseChainData(query())).penaltyCoverage.unsupportedBlocks).toBe(3);
    expect(rpc.call.mock.calls.some(([method]) => method === 'protx')).toBe(false);
  });

  it('keeps a historical state mismatch unknown without losing verified membership', async () => {
    const snapshots = enablePenaltyEvidence(); snapshots.get(chainHash(100))!.penalty = 99;
    await service.collectOnce();
    const data = await getPoseChainData(query());
    expect(data.penaltyCoverage.inconsistentBlocks).toBe(1);
    const row = data.commitments.find((item) => item.blockHeight === 100)!;
    expect(row).toMatchObject({ evidence: 'chain_verified_membership', penaltyAttributionStatus: 'inconsistent',
      penaltyAttributionReason: 'state_mismatch' });
    expect(row.members[1]).toMatchObject({ penaltyEvidence: 'unknown', penalty: null });
  });

  it('retracts penalty and ban claims with their orphan block and recomputes the new branch', async () => {
    const snapshots = enablePenaltyEvidence(); await service.collectOnce();
    blocks.set(101, block(101, 1)); blocks.set(102, block(102, 1));
    for (const height of [101, 102]) {
      blocks.get(height)!.tx.unshift({ txid: chainHash(60000 + height), type: 5, vin: [{ coinbase: '01' }] });
      snapshots.set(blocks.get(height)!.hash, { height, penalty: 100, banHeight: 100 });
    }
    await service.collectOnce();
    const data = await getPoseChainData(query());
    expect(data.penaltyCoverage).toMatchObject({ commitmentBlocks: 3, verifiedBlocks: 3 });
    expect(data.quorumSummary[0]).toMatchObject({ penaltyApplications: 3, newBans: 1 });
    expect(data.commitments[0]).toMatchObject({ blockHash: chainHash(1102), penaltyAttributionStatus: 'verified' });
    expect(await PoseChainBlock.countDocuments({ canonical: false, 'penaltyAttribution.status': 'verified' })).toBe(2);
  });

  it('detects a reorg during historical scoring and suppresses all chain evidence', async () => {
    enablePenaltyEvidence();
    hook = (method) => { if (method === 'protx') blocks.set(100, block(100, 1)); };
    await expect(service.collectOnce()).rejects.toThrow(/attribution reorganized/);
    expect(await getPoseChainData(query())).toMatchObject({ status: 'unavailable', total: 0,
      penaltyCoverage: { verifiedBlocks: 0, commitmentBlocks: 0 } });
  });

  it('counts a ban once across multiple quorums in the same block, retaining transaction order', async () => {
    const snapshots = enablePenaltyEvidence(); snapshots.get(chainHash(99))!.penalty = 0;
    blocks.get(100)!.tx.push({ txid: chainHash(30000), type: 6,
      extraPayload: commitmentPayload({ height: 100, quorumHash: chainHash(1000), quorumType: 2 }) });
    await service.collectOnce();
    const data = await getPoseChainData(query());
    const first = data.commitments.find((row) => row.txid === blocks.get(100)!.tx[1].txid)!;
    const second = data.commitments.find((row) => row.txid === chainHash(30000))!;
    expect(first.members[1].penalty).toMatchObject({ beforePenalty: 0, afterPenalty: 66, causedBan: false });
    expect(second.members[1].penalty).toMatchObject({ beforePenalty: 66, afterPenalty: 100, appliedDelta: 34, causedBan: true });
    expect(data.quorumSummary.find((row) => row.quorumType === 7)).toMatchObject({ newBans: 0 });
    expect(data.quorumSummary.find((row) => row.quorumType === 2)).toMatchObject({ newBans: 1 });
    expect(poseChainDataSchema.safeParse(data).success).toBe(true);
    const ban = await getBanAttribution({ proTxHash: chainHash(2), banHeight: 100 });
    expect(ban).toMatchObject({ status: 'verified', proof: { txid: chainHash(30000), quorumType: 2,
      penalty: { beforePenalty: 66, afterPenalty: 100, appliedDelta: 34 } } });
    expect(banAttributionDataSchema.safeParse(ban).success).toBe(true);
  });

  it('counts exact observers separately and permits a verified ban in a partial collected prefix', async () => {
    enablePenaltyEvidence(); config.poseChain.blocksPerRun = 1; await service.collectOnce();
    const commitment = blocks.get(100)!.tx[1];
    const event = poseEvent({ eventAt: new Date(Date.now() - 1000).toISOString(), kind: 'ban',
      eventBlockHash: chainHash(100), eventBlockHeight: 100, quorumType: 7, quorumHash: chainHash(1000),
      proTxHash: chainHash(2), poseBanHeight: 100 });
    for (let i = 0; i < 12; i++) await poseTelemetryService.ingest(posePayload({ nodeId: `ban-observer-${i}`, poseEvents: [event] }));
    await poseTelemetryService.ingest(posePayload({ nodeId: 'ban-observer-0', sequence: 99,
      poseEvents: [{ ...event, kind: 'penalty_change', eventId: 'same-node-again' }] }));
    const variations = [{ eventBlockHash: chainHash(999) }, { eventBlockHeight: 101 }, { quorumType: 2 },
      { quorumHash: chainHash(999) }, { proTxHash: chainHash(1) }, { kind: 'recovery' as const },
      { eventAt: new Date(Date.now() + 3600000).toISOString() }];
    for (let i = 0; i < variations.length; i++) await poseTelemetryService.ingest(posePayload({
      nodeId: `wrong-ban-observer-${i}`, poseEvents: [{ ...event, ...variations[i] }] }));
    await poseTelemetryService.ingest(posePayload({ nodeId: 'expired-ban-observer', poseEvents: [event] }));
    await PoseObservation.updateMany({ nodeId: 'expired-ban-observer' }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    await poseTelemetryService.ingest(posePayload({ nodeId: 'future-ban-observer',
      observedAt: new Date(Date.now() + 3600000).toISOString(), poseEvents: [event] }));
    const countsBefore = await PoseChainBlock.countDocuments();
    const ban = await getBanAttribution({ proTxHash: chainHash(2), banHeight: 100 });
    expect(ban).toMatchObject({ status: 'verified', coverage: { caughtUp: false, confirmedThroughHeight: 100 },
      proof: { txid: commitment.txid, quorumType: 7, observerCount: 12 } });
    expect(banAttributionDataSchema.safeParse(ban).success).toBe(true);
    expect(await PoseChainBlock.countDocuments()).toBe(countsBefore);
    await PoseObservation.updateOne({ nodeId: 'future-ban-observer' }, { $set: { observedAt: new Date(Date.now() - 1000) } });
    expect(await getBanAttribution({ proTxHash: chainHash(2), banHeight: 100 }))
      .toMatchObject({ status: 'verified', proof: { observerCount: 13 } });
    expect(await getBanAttribution({ proTxHash: chainHash(1), banHeight: 100 })).toMatchObject({
      status: 'unknown', reason: 'ban_not_attributed', proof: null });
    expect(await getBanAttribution({ proTxHash: chainHash(2), banHeight: 101 })).toMatchObject({
      status: 'unknown', reason: 'after_coverage', proof: null });
  });

  it('excludes an observer that expires while the ban attribution is being read', async () => {
    enablePenaltyEvidence(); config.poseChain.blocksPerRun = 1; await service.collectOnce();
    const now = Date.now();
    const event = poseEvent({ eventAt: new Date(now - 60000).toISOString(), kind: 'ban',
      eventBlockHash: chainHash(100), eventBlockHeight: 100, quorumType: 7, quorumHash: chainHash(1000),
      proTxHash: chainHash(2), poseBanHeight: 100 });
    await poseTelemetryService.ingest(posePayload({ nodeId: 'short-lived', poseEvents: [event] }));
    await poseTelemetryService.ingest(posePayload({ nodeId: 'still-valid', poseEvents: [event] }));
    await poseTelemetryService.ingest(posePayload({ nodeId: 'still-valid',
      poseEvents: [{ ...event, kind: 'penalty_change', eventId: 'another-report' }] }));
    await PoseObservation.updateOne({ nodeId: 'short-lived' }, { $set: { expiresAt: new Date(now + 1000) } });
    await PoseObservation.updateOne({ nodeId: 'still-valid', kind: 'ban' }, { $set: { expiresAt: new Date(now + 1000) } });
    const findOne = PoseChainState.findOne.bind(PoseChainState);
    let calls = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    const spy = vi.spyOn(PoseChainState, 'findOne').mockImplementation(((...args: Parameters<typeof findOne>) => {
      calls++;
      if (calls === 2) vi.setSystemTime(now + 2000);
      return findOne(...args);
    }) as typeof PoseChainState.findOne);
    try {
      const data = await getBanAttribution({ proTxHash: chainHash(2), banHeight: 100 });
      expect(data).toMatchObject({ status: 'verified', proof: { observerCount: 1 } });
      expect(banAttributionDataSchema.safeParse(data).success).toBe(true);
    } finally {
      spy.mockRestore(); vi.useRealTimers();
    }
  });

  it('retracts a pinned orphan ban and suppresses altered stored state despite a verified label', async () => {
    const snapshots = enablePenaltyEvidence(); await service.collectOnce();
    const query = { proTxHash: chainHash(2), banHeight: 100, blockHash: chainHash(100) };
    expect((await getBanAttribution(query)).status).toBe('verified');
    for (const height of [100, 101, 102]) {
      blocks.set(height, block(height, 1));
      blocks.get(height)!.tx.unshift({ txid: chainHash(60000 + height), type: 5, vin: [{ coinbase: '01' }] });
      snapshots.set(blocks.get(height)!.hash, { height, penalty: 100, banHeight: 100 });
    }
    await service.collectOnce();
    expect(await getBanAttribution(query)).toMatchObject({ status: 'unknown', reason: 'block_hash_mismatch', proof: null });
    const canonical = await getBanAttribution({ ...query, blockHash: chainHash(1100) });
    expect(canonical).toMatchObject({ status: 'verified', proof: { blockHash: chainHash(1100) } });
    await PoseChainBlock.updateOne({ canonical: true, height: 100 }, { $set: { 'penaltyAttribution.after.0.penalty': 1 } });
    expect(await getBanAttribution({ proTxHash: chainHash(2), banHeight: 100 })).toMatchObject({
      status: 'unknown', reason: 'inconsistent', proof: null });
  });
});
