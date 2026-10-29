import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { poseObservedEventsApiResponseSchema, poseEventsQuerySchema } from '@defcon/shared/dist/contracts';
import { PoseObservation } from '../src/models/PoseObservation';
import { NetworkNoiseNodeState } from '../src/models/NetworkNoiseNodeState';
import { NetworkNoiseObservation } from '../src/models/NetworkNoiseObservation';
import { poseTelemetryService } from '../src/services/poseTelemetry.service';
import { networkNoiseService } from '../src/services/networkNoise.service';
import { poseEvent, posePayload } from './fixtures/poseTelemetry';

// This suite requires an explicitly supplied disposable localhost database.
// The normal unit suite must never connect to an operator's configured MongoDB.
const uri = process.env.TEST_POSE_MONGO_URI;
describe.skipIf(!uri)('PoSe telemetry with disposable MongoDB', () => {
  beforeAll(async () => {
    if (!uri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/deftrack_pose_test_[a-f0-9]+$/.test(uri)) {
      throw new Error('TEST_POSE_MONGO_URI must name an isolated localhost test database');
    }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    await Promise.all([PoseObservation.init(), NetworkNoiseNodeState.init(), NetworkNoiseObservation.init()]);
  });
  beforeEach(async () => {
    await Promise.all([PoseObservation.deleteMany({}), NetworkNoiseNodeState.deleteMany({}), NetworkNoiseObservation.deleteMany({})]);
  });
  afterAll(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  function payload(overrides: Parameters<typeof posePayload>[0] = {}) {
    const eventAt = new Date(Date.now() - 60000).toISOString();
    return posePayload({
      observedAt: new Date().toISOString(),
      poseEvents: [poseEvent({ eventAt })],
      ...overrides,
    });
  }
  const query = (overrides: Record<string, unknown> = {}) => poseEventsQuerySchema.parse(overrides);

  it('stores one event with twelve distinct observers and deduplicates later sequences', async () => {
    for (let i = 0; i < 12; i++) {
      await networkNoiseService.ingest(payload({ nodeId: `node-${i}`, nodeRole: i < 3 ? 'seed' : 'fullnode' }));
    }
    const retry = await networkNoiseService.ingest(payload({ nodeId: 'node-0', sequence: 13 }));
    expect(retry.acceptedPoseObservations).toBe(0);
    expect(await PoseObservation.countDocuments()).toBe(12);
    const data = await poseTelemetryService.getEvents(query());
    expect(data).toMatchObject({ total: 1, observationCount: 12, chainVerifiedEvents: 0, uncorrelatedEvents: 0 });
    expect(data.events[0]).toMatchObject({
      observerCount: 12, observationCount: 12, evidence: 'log_observed', canonicalStatus: 'unverified',
      quorumType: 2, hasConflictingScores: false, eventBlockHeight: 147909,
    });
    expect(data.events[0].observerRoles).toEqual(['fullnode', 'seed']);
    expect(poseObservedEventsApiResponseSchema.safeParse({ success: true, data }).success).toBe(true);
  });

  it('filters observations by the complete ban anchor without promoting log evidence', async () => {
    const first = payload();
    const event = first.poseEvents[0];
    await poseTelemetryService.ingest(first);
    const mismatches = [ { eventBlockHash: 'e'.repeat(64) }, { eventBlockHeight: event.eventBlockHeight! + 1 },
      { quorumHash: 'f'.repeat(64) }, { quorumType: 7 }, { proTxHash: '1'.repeat(64) } ];
    for (const [index, mismatch] of mismatches.entries()) await poseTelemetryService.ingest(payload({
      nodeId: `mismatch-${index}`, poseEvents: [{ ...event, ...mismatch }],
    }));
    const data = await poseTelemetryService.getEvents(query({ proTxHash: event.proTxHash!, quorumType: event.quorumType!,
      eventBlockHeight: event.eventBlockHeight!, eventBlockHash: event.eventBlockHash!.toUpperCase(), quorumHash: event.quorumHash!.toUpperCase() }));
    expect(data).toMatchObject({ total: 1, observationCount: 1, chainVerifiedEvents: 0 });
    expect(data.events[0]).toMatchObject({ eventBlockHash: event.eventBlockHash, eventBlockHeight: event.eventBlockHeight,
      quorumHash: event.quorumHash, observerCount: 1, canonicalStatus: 'unverified', evidence: 'log_observed' });
    expect(data.events[0].observerNodeIds).toEqual([first.nodeId]);
  });

  it('handles concurrent unique-key races without duplicate records', async () => {
    const source = payload();
    await Promise.all(Array.from({ length: 12 }, () => poseTelemetryService.ingest(source)));
    expect(await PoseObservation.countDocuments()).toBe(1);
  });

  it.each([12, 13])('keeps the newer v2 snapshot when sequence %i finishes last', async (delayedSequence) => {
    const first = payload({ sequence: 12, poseEvents: [] });
    const { poseEvents: _events, ...legacy } = first;
    let releaseDelayed!: () => void;
    let delayedWaiting!: () => void;
    const delayedBlocked = new Promise<void>((resolve) => { delayedWaiting = resolve; });
    const continueDelayed = new Promise<void>((resolve) => { releaseDelayed = resolve; });
    const update = NetworkNoiseNodeState.updateOne.bind(NetworkNoiseNodeState);
    const spy = vi.spyOn(NetworkNoiseNodeState, 'updateOne').mockImplementation(async (...args: Parameters<typeof update>) => {
      const change = args[1] as { $set?: { lastSequence?: number } };
      if (change.$set?.lastSequence === delayedSequence) { delayedWaiting(); await continueDelayed; }
      return update(...args);
    });
    const older = { ...legacy, schemaVersion: 1 as const };
    const newer = payload({ sequence: 13, snapshot: { ip: '198.51.100.41', blockHeight: 200 } });
    const delayed = networkNoiseService.ingest(delayedSequence === 12 ? older : newer);
    try {
      await delayedBlocked;
      await networkNoiseService.ingest(delayedSequence === 12 ? newer : older);
    } finally {
      releaseDelayed();
      await delayed;
      spy.mockRestore();
    }
    const state = await NetworkNoiseNodeState.findOne({ nodeId: first.nodeId }).lean();
    expect(state).toMatchObject({ lastSequence: 13, ip: '198.51.100.41', blockHeight: 200 });
    expect(state?.lastCleanAt).toEqual(delayedSequence === 12 ? null : new Date(older.observedAt));
    expect(await PoseObservation.countDocuments()).toBe(1);
    expect((await networkNoiseService.ingest(first)).duplicate).toBe(true);
  });

  it('accepts sequence zero for a new node and rejects its retry', async () => {
    const first = payload({ sequence: 0 });
    expect((await networkNoiseService.ingest(first)).duplicate).toBe(false);
    expect((await networkNoiseService.ingest(first)).duplicate).toBe(true);
    expect((await NetworkNoiseNodeState.findOne({ nodeId: first.nodeId }).lean())?.lastSequence).toBe(0);
    expect(await PoseObservation.countDocuments()).toBe(1);
  });

  it('preserves alternate block hashes as separate unverified candidates', async () => {
    const first = payload();
    await poseTelemetryService.ingest(first);
    await poseTelemetryService.ingest(payload({
      nodeId: 'node-b', poseEvents: [{ ...first.poseEvents[0], eventBlockHash: 'e'.repeat(64) }],
    }));
    const data = await poseTelemetryService.getEvents(query());
    expect(data.total).toBe(2);
    expect(new Set(data.events.map((event) => event.eventBlockHash)).size).toBe(2);
    expect(data.events.every((event) => event.canonicalStatus === 'unverified')).toBe(true);
  });

  it('keeps quorum types and multiple members distinct and supports filtering/pagination', async () => {
    const first = payload();
    await poseTelemetryService.ingest({ ...first, poseEvents: [
      first.poseEvents[0],
      { ...first.poseEvents[0], eventId: 'log-offset-102', quorumType: 7 },
      { ...first.poseEvents[0], eventId: 'log-offset-103', proTxHash: 'e'.repeat(64) },
    ] });
    const filtered = await poseTelemetryService.getEvents(query({ quorumType: 7 }));
    expect(filtered.total).toBe(1);
    expect(filtered.events[0].quorumType).toBe(7);
    const byNode = await poseTelemetryService.getEvents(query({ proTxHash: 'E'.repeat(64) }));
    expect(byNode.total).toBe(1);
    const firstPage = await poseTelemetryService.getEvents(query({ limit: 1 }));
    const secondPage = await poseTelemetryService.getEvents(query({ limit: 1, page: 2 }));
    expect(firstPage.total).toBe(3);
    expect(secondPage.total).toBe(3);
    expect(firstPage.events[0].eventKey).not.toBe(secondPage.events[0].eventKey);
  });

  it('exposes score disagreements without increasing event or observer counts', async () => {
    const first = payload();
    await poseTelemetryService.ingest(first);
    await poseTelemetryService.ingest({ ...first, sequence: 13, poseEvents: [{ ...first.poseEvents[0], penalty: 146 }] });
    const data = await poseTelemetryService.getEvents(query());
    expect(data.total).toBe(1);
    expect(data.events[0]).toMatchObject({ observerCount: 1, observationCount: 2, hasConflictingScores: true });
    expect(data.events[0].scoreVariants).toHaveLength(2);
  });

  it('does not use snapshot height or time proximity to correlate incomplete logs', async () => {
    const first = payload();
    const event = { ...first.poseEvents[0], eventBlockHeight: null, eventBlockHash: null, quorumHash: null };
    await poseTelemetryService.ingest({ ...first, poseEvents: [event] });
    await poseTelemetryService.ingest({ ...first, nodeId: 'node-b', poseEvents: [event] });
    const data = await poseTelemetryService.getEvents(query());
    expect(data).toMatchObject({ total: 2, uncorrelatedEvents: 2 });
    expect(data.events.every((entry) => entry.eventBlockHeight === null && entry.observerCount === 1)).toBe(true);
    expect((await PoseObservation.findOne().lean())?.snapshotBlockHeight).toBe(147912);
  });

  it('keeps quorum build failures local even with complete-looking hashes', async () => {
    const first = payload();
    const event = { ...first.poseEvents[0], kind: 'quorum_build_failure' as const };
    await poseTelemetryService.ingest({ ...first, poseEvents: [event] });
    await poseTelemetryService.ingest({ ...first, nodeId: 'node-b', poseEvents: [event] });
    expect(await poseTelemetryService.getEvents(query({ kind: 'quorum_build_failure' })))
      .toMatchObject({ total: 2, uncorrelatedEvents: 2, chainVerifiedEvents: 0 });
  });

  it('retries safely after a state-write failure without duplicating either store', async () => {
    const first = payload({ signals: [{
      type: 'pose_instability', fingerprint: 'shared-log-fingerprint', count: 12,
      firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    }] });
    vi.spyOn(NetworkNoiseNodeState, 'updateOne').mockRejectedValueOnce(new Error('state write failed'));
    await expect(networkNoiseService.ingest(first)).rejects.toThrow('state write failed');
    expect(await PoseObservation.countDocuments()).toBe(1);
    const retried = await networkNoiseService.ingest(first);
    expect(retried.acceptedPoseObservations).toBe(0);
    expect(await PoseObservation.countDocuments()).toBe(1);
    expect(await NetworkNoiseObservation.countDocuments()).toBe(1);
    expect((await NetworkNoiseNodeState.findOne().lean())?.lastSequence).toBe(12);
  });

  it('queries by event time, excludes future/expired records and keeps TTL independent', async () => {
    const first = payload();
    await poseTelemetryService.ingest(first);
    await poseTelemetryService.ingest({ ...first, poseEvents: [{
      ...first.poseEvents[0], eventId: 'log-offset-102', proTxHash: 'e'.repeat(64),
      eventAt: new Date(Date.now() - 2 * 3600000).toISOString(),
    }] });
    await poseTelemetryService.ingest({ ...first, poseEvents: [{
      ...first.poseEvents[0], eventId: 'log-offset-103', proTxHash: 'f'.repeat(64),
      eventAt: new Date(Date.now() + 2 * 3600000).toISOString(),
    }] });
    expect((await poseTelemetryService.getEvents(query({ hours: 1 }))).total).toBe(1);
    const record = await PoseObservation.findOne({ proTxHash: 'c'.repeat(64) }).lean();
    expect(record!.expiresAt.getTime() - record!.receivedAt.getTime()).toBe(365 * 86400000);
    await PoseObservation.updateOne({ proTxHash: 'c'.repeat(64) }, { $set: { expiresAt: new Date(0) } });
    expect((await poseTelemetryService.getEvents(query({ hours: 1 }))).total).toBe(0);
    const indexes = await PoseObservation.collection.indexes();
    expect(indexes.some((index) => index.key.expiresAt === 1 && index.expireAfterSeconds === 0)).toBe(true);
    expect(indexes.some((index) => index.key.observationKey === 1 && index.unique)).toBe(true);
  });
});
