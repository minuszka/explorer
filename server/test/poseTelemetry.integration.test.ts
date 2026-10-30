import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { poseObservedEventsApiResponseSchema, poseEventsQuerySchema } from '@defcon/shared/dist/contracts';
import { PoseObservation } from '../src/models/PoseObservation';
import { NetworkNoiseNodeState } from '../src/models/NetworkNoiseNodeState';
import { NetworkNoiseObservation } from '../src/models/NetworkNoiseObservation';
import { NetworkNoiseBaseline, NetworkNoiseBatch } from '../src/models/NetworkNoiseBatch';
import { networkNoiseBatchService, NetworkNoiseSequenceConflict } from '../src/services/networkNoiseBatch.service';
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
    await Promise.all([PoseObservation.deleteMany({}), NetworkNoiseNodeState.deleteMany({}), NetworkNoiseObservation.deleteMany({}), NetworkNoiseBaseline.deleteMany({}), NetworkNoiseBatch.deleteMany({})]);
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

  it('recovers a missing lower batch without rewinding the node and rejects conflicting replays', async () => {
    const event = poseEvent({ eventAt: new Date(Date.now() - 60000).toISOString() });
    const first = payload({ sequence: 10, poseEvents: [] });
    const newer = payload({ sequence: 12, snapshot: { ip: '198.51.100.41', blockHeight: 200 }, poseEvents: [] });
    const late = payload({ sequence: 11, poseEvents: [event] });
    await networkNoiseService.ingest(first);
    await networkNoiseService.ingest(newer);
    expect(await networkNoiseService.ingest(late)).toMatchObject({ duplicate: false, acceptedPoseObservations: 1 });
    expect(await networkNoiseService.ingest(late)).toMatchObject({ duplicate: true, acceptedPoseObservations: 0 });
    await expect(networkNoiseService.ingest({ ...late, poseEvents: [{ ...event, penalty: 146 }] }))
      .rejects.toBeInstanceOf(NetworkNoiseSequenceConflict);
    expect(await PoseObservation.countDocuments()).toBe(1);
    expect(await NetworkNoiseNodeState.findOne({ nodeId: first.nodeId }).lean())
      .toMatchObject({ lastSequence: 12, ip: '198.51.100.41', blockHeight: 200 });
  });

  it('keeps the legacy high-water mark conservative when the receipt history starts', async () => {
    const first = payload({ sequence: 12 });
    await NetworkNoiseNodeState.create({ nodeId: first.nodeId, lastSequence: 12,
      ip: first.snapshot.ip, lastReportedAt: new Date(first.observedAt) });
    expect((await networkNoiseService.ingest({ ...first, sequence: 11 })).duplicate).toBe(true);
    expect((await networkNoiseService.ingest(first)).duplicate).toBe(true);
    expect((await networkNoiseService.ingest({ ...first, sequence: 14 })).duplicate).toBe(false);
    expect((await networkNoiseService.ingest({ ...first, sequence: 13 })).duplicate).toBe(false);
    expect((await NetworkNoiseNodeState.findOne({ nodeId: first.nodeId }).lean())?.lastSequence).toBe(14);
  });

  it('retries an incomplete batch after a newer batch has committed', async () => {
    const first = payload({ sequence: 10, poseEvents: [] });
    const late = payload({ sequence: 11 });
    await networkNoiseService.ingest(first);
    const spy = vi.spyOn(PoseObservation, 'bulkWrite').mockRejectedValueOnce(new Error('write interrupted'));
    await expect(networkNoiseService.ingest(late)).rejects.toThrow('write interrupted');
    spy.mockRestore();
    await networkNoiseService.ingest(payload({ sequence: 12, poseEvents: [] }));
    expect(await networkNoiseService.ingest(late)).toMatchObject({ duplicate: false, acceptedPoseObservations: 1 });
    expect((await NetworkNoiseNodeState.findOne({ nodeId: first.nodeId }).lean())?.lastSequence).toBe(12);
  });

  it('retries when marking the receipt complete fails after the snapshot write', async () => {
    const source = payload({ sequence: 12 });
    const spy = vi.spyOn(NetworkNoiseBatch, 'updateOne').mockRejectedValueOnce(new Error('receipt write interrupted'));
    await expect(networkNoiseService.ingest(source)).rejects.toThrow('receipt write interrupted');
    spy.mockRestore();
    expect((await NetworkNoiseNodeState.findOne({ nodeId: source.nodeId }).lean())?.lastSequence).toBe(12);
    expect(await networkNoiseService.ingest(source)).toMatchObject({ duplicate: false, acceptedPoseObservations: 0 });
    expect(await PoseObservation.countDocuments()).toBe(1);
    expect((await networkNoiseService.ingest(source)).duplicate).toBe(true);
  });

  it('sets one legacy baseline under concurrent first requests', async () => {
    const source = payload({ sequence: 12, poseEvents: [] });
    await NetworkNoiseNodeState.create({ nodeId: source.nodeId, lastSequence: 12,
      ip: source.snapshot.ip, lastReportedAt: new Date(source.observedAt) });
    await Promise.all([networkNoiseService.ingest({ ...source, sequence: 14 }),
      networkNoiseService.ingest({ ...source, sequence: 15 })]);
    expect((await NetworkNoiseBaseline.findOne({ nodeId: source.nodeId }).lean())?.legacySequence).toBe(12);
    expect((await networkNoiseService.ingest({ ...source, sequence: 13 })).duplicate).toBe(false);
    expect((await NetworkNoiseNodeState.findOne({ nodeId: source.nodeId }).lean())?.lastSequence).toBe(15);
  });

  it('deduplicates simultaneous identical batches and refuses a different payload for the sequence', async () => {
    const source = payload();
    const results = await Promise.all(Array.from({ length: 8 }, () => networkNoiseService.ingest(source)));
    expect(results.some(result => !result.duplicate)).toBe(true);
    expect(await PoseObservation.countDocuments()).toBe(1);
    expect(await NetworkNoiseBatch.countDocuments()).toBe(1);
    await expect(networkNoiseService.ingest({ ...source, signals: [{ type: 'stale_peer', fingerprint: '12345678',
      count: 1, firstSeenAt: source.observedAt, lastSeenAt: source.observedAt }] }))
      .rejects.toBeInstanceOf(NetworkNoiseSequenceConflict);
  });

  it('allows only one content identity for simultaneous requests with the same sequence', async () => {
    const source = payload();
    const different = { ...source, snapshot: { ...source.snapshot, blockHeight: 99 } };
    const results = await Promise.allSettled([networkNoiseService.ingest(source), networkNoiseService.ingest(different)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected' && result.reason instanceof NetworkNoiseSequenceConflict)).toHaveLength(1);
    expect(await NetworkNoiseBatch.countDocuments()).toBe(1);
    expect(await PoseObservation.countDocuments()).toBe(1);
  });

  it('recovers a delayed v1 signal without replacing the newer state', async () => {
    const v2 = payload({ sequence: 10, poseEvents: [] });
    const { poseEvents: _events, ...base } = v2;
    const late = { ...base, schemaVersion: 1 as const, sequence: 11,
      signals: [{ type: 'stale_peer', fingerprint: '12345678', count: 1,
        firstSeenAt: base.observedAt, lastSeenAt: base.observedAt }] };
    await networkNoiseService.ingest(v2);
    await networkNoiseService.ingest({ ...v2, sequence: 12 });
    expect(await networkNoiseService.ingest(late)).toMatchObject({ duplicate: false, acceptedSignals: 1 });
    expect(await networkNoiseService.ingest(late)).toMatchObject({ duplicate: true, acceptedSignals: 0 });
    expect(await NetworkNoiseObservation.countDocuments()).toBe(1);
    expect((await NetworkNoiseNodeState.findOne({ nodeId: v2.nodeId }).lean())?.lastSequence).toBe(12);
  });

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

  it('treats a future-dated node report as stale without counting its active signals', async () => {
    const now = Date.now();
    const future = new Date(now + 3600000).toISOString();
    const recent = new Date(now - 1000).toISOString();
    const signal = { type: 'chainlock_conflict', fingerprint: 'freshness-test', count: 4,
      firstSeenAt: recent, lastSeenAt: recent };
    await networkNoiseService.ingest(payload({ nodeId: 'future-node', observedAt: future, poseEvents: [], signals: [signal] }));
    await networkNoiseService.ingest(payload({ nodeId: 'fresh-node', observedAt: recent, poseEvents: [], signals: [] }));
    const result = await networkNoiseService.getSummary(24);
    expect(result.summary).toMatchObject({ knownNodes: 2, reportingNodes: 1, staleNodes: 1, activeSignals: 0, chainAlerts: 0 });
    expect(result.nodes.find((entry) => entry.nodeId === 'future-node')?.isStale).toBe(true);
    expect(result.nodes.find((entry) => entry.nodeId === 'fresh-node')?.isStale).toBe(false);
    expect(result.timeline).toEqual([]);
    expect(result.recentSignals).toEqual([]);
  });

  it.each([1, 2] as const)('keeps a future v%i report stale after the clock catches up until a valid batch', async (version) => {
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString();
    const source = payload({ observedAt: new Date(now + 60000).toISOString(), poseEvents: [], signals: [
      { type: 'chainlock_conflict', fingerprint: 'future-report', count: 1, firstSeenAt: recent, lastSeenAt: recent },
    ] });
    const { poseEvents: _events, ...common } = source;
    const report = version === 1 ? { ...common, schemaVersion: 1 as const } : source;
    try {
      await networkNoiseService.ingest(report);
      expect((await networkNoiseService.getSummary()).summary).toMatchObject({ reportingNodes: 0, chainAlerts: 0 });
      vi.setSystemTime(now + 61000);
      const caughtUp = await networkNoiseService.getSummary();
      expect(caughtUp.summary).toMatchObject({ reportingNodes: 0, staleNodes: 1, activeSignals: 0, chainAlerts: 0 });
      expect(caughtUp.nodes[0].isStale).toBe(true);
      await networkNoiseService.ingest({ ...report, sequence: report.sequence + 1,
        observedAt: new Date(now + 60000).toISOString(), signals: [] });
      expect((await networkNoiseService.getSummary()).summary).toMatchObject({ reportingNodes: 1, staleNodes: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats legacy snapshots without verified report time as stale until a valid batch', async () => {
    const report = payload({ observedAt: new Date().toISOString(), poseEvents: [], signals: [] });
    await networkNoiseService.ingest(report);
    await NetworkNoiseNodeState.collection.updateOne({ nodeId: report.nodeId }, { $unset: { reportTimeVerified: '' } });
    expect((await networkNoiseService.getSummary()).summary).toMatchObject({ reportingNodes: 0, staleNodes: 1 });
    await networkNoiseService.ingest({ ...report, sequence: report.sequence + 1 });
    expect((await networkNoiseService.getSummary()).summary).toMatchObject({ reportingNodes: 1, staleNodes: 0 });
  });

  it('checks report time before a delayed batch claim', async () => {
    const now = Date.now();
    const report = payload({ observedAt: new Date(now + 60000).toISOString(), poseEvents: [], signals: [] });
    const originalClaim = networkNoiseBatchService.claim;
    const claim = vi.spyOn(networkNoiseBatchService, 'claim').mockImplementation(async (batch) => {
      const result = await originalClaim(batch);
      vi.setSystemTime(now + 61000);
      return result;
    });
    try {
      await networkNoiseService.ingest(report);
      expect((await networkNoiseService.getSummary()).summary).toMatchObject({ reportingNodes: 0, staleNodes: 1 });
    } finally {
      claim.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([[1, 'firstSeenAt'], [1, 'lastSeenAt'], [2, 'firstSeenAt'], [2, 'lastSeenAt']] as const)(
    'does not treat future %s report signal %s as a current node snapshot', async (version, futureField) => {
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString();
    const future = new Date(now + 3600000).toISOString();
    const source = payload({ observedAt: recent, poseEvents: [], signals: [
      { type: 'chainlock_conflict', fingerprint: 'future-signal', count: 1, firstSeenAt: recent, lastSeenAt: recent,
        [futureField]: future },
    ] });
    const { poseEvents: _events, ...common } = source;
    const report = version === 1 ? { ...common, schemaVersion: 1 as const } : source;
    await networkNoiseService.ingest(report);
    const result = await networkNoiseService.getSummary(24);
    expect(result.summary).toMatchObject({ knownNodes: 1, reportingNodes: 0, staleNodes: 1, activeSignals: 0, chainAlerts: 0 });
    expect(result.nodes[0].isStale).toBe(true);
    expect(result.timeline).toEqual([]);
    expect(result.recentSignals).toEqual([]);

    await networkNoiseService.ingest({ ...report, sequence: report.sequence + 1, signals: [] });
    const recovered = await networkNoiseService.getSummary(24);
    expect(recovered.summary).toMatchObject({ reportingNodes: 1, staleNodes: 0, activeSignals: 0, chainAlerts: 0 });
    expect(recovered.nodes[0].isStale).toBe(false);
  });

  it.each([1, 2] as const)('excludes an inverted signal interval in a v%i report until recovery', async (version) => {
    const now = Date.now();
    const first = new Date(now - 1000).toISOString();
    const last = new Date(now - 2000).toISOString();
    const source = payload({ observedAt: first, poseEvents: [], signals: [
      { type: 'chainlock_conflict', fingerprint: 'inverted-interval', count: 1, firstSeenAt: first, lastSeenAt: last },
    ] });
    const { poseEvents: _events, ...common } = source;
    const report = version === 1 ? { ...common, schemaVersion: 1 as const } : source;
    await networkNoiseService.ingest(report);
    const result = await networkNoiseService.getSummary(24);
    expect(result.summary).toMatchObject({ knownNodes: 1, reportingNodes: 0, staleNodes: 1, activeSignals: 0, chainAlerts: 0 });
    expect(result.nodes[0].isStale).toBe(true);
    expect(result.timeline).toEqual([]);
    expect(result.recentSignals).toEqual([]);
    await networkNoiseService.ingest({ ...report, sequence: report.sequence + 1, signals: [] });
    expect((await networkNoiseService.getSummary(24)).summary).toMatchObject({ reportingNodes: 1, staleNodes: 0 });
  });

  it('treats older snapshots with unverified signal times as stale until a new report', async () => {
    const now = new Date().toISOString();
    const report = payload({ observedAt: now, poseEvents: [], signals: [
      { type: 'chainlock_conflict', fingerprint: 'legacy-signal', count: 1, firstSeenAt: now, lastSeenAt: now },
    ] });
    await networkNoiseService.ingest(report);
    await NetworkNoiseNodeState.collection.updateOne({ nodeId: report.nodeId }, { $unset: { signalTimingInvalid: '' } });
    expect((await networkNoiseService.getSummary(24)).summary).toMatchObject({ reportingNodes: 0, staleNodes: 1, chainAlerts: 0 });
    await networkNoiseService.ingest({ ...report, sequence: report.sequence + 1 });
    expect((await networkNoiseService.getSummary(24)).summary).toMatchObject({ reportingNodes: 1, staleNodes: 0, chainAlerts: 1 });
  });

  it('treats pre-interval-check snapshots with signals as stale until a verified report', async () => {
    const now = new Date().toISOString();
    const report = payload({ observedAt: now, poseEvents: [], signals: [
      { type: 'chainlock_conflict', fingerprint: 'unchecked-interval', count: 1, firstSeenAt: now, lastSeenAt: now },
    ] });
    await networkNoiseService.ingest(report);
    await NetworkNoiseNodeState.collection.updateOne({ nodeId: report.nodeId }, { $unset: { signalIntervalVerified: '' } });
    expect((await networkNoiseService.getSummary(24)).summary).toMatchObject({ reportingNodes: 0, staleNodes: 1, chainAlerts: 0 });
    await networkNoiseService.ingest({ ...report, sequence: report.sequence + 1 });
    expect((await networkNoiseService.getSummary(24)).summary).toMatchObject({ reportingNodes: 1, staleNodes: 0, chainAlerts: 1 });
  });

  it('excludes future and expired signals from the timeline and recent evidence', async () => {
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString();
    const future = new Date(now + 3600000).toISOString();
    const signal = (type: string, at: string) => ({ type, fingerprint: `fingerprint-${type}`, count: 1,
      firstSeenAt: at, lastSeenAt: at });
    await networkNoiseService.ingest(payload({ poseEvents: [], signals: [signal('fresh_signal', recent),
      signal('expired_signal', recent), signal('future_signal', future)] }));
    await NetworkNoiseObservation.updateOne({ signalType: 'expired_signal' }, { $set: { expiresAt: new Date(now - 1000) } });
    expect(await NetworkNoiseObservation.countDocuments({ signalType: 'expired_signal' })).toBe(1);
    const result = await networkNoiseService.getSummary(24);
    expect(result.recentSignals.map((entry) => entry.signalType)).toEqual(['fresh_signal']);
    expect(result.timeline.map((entry) => entry.signalType)).toEqual(['fresh_signal']);
  });

  it('excludes future-dated reports from PoSe observer counts until their report time', async () => {
    const now = Date.now();
    const first = payload({ observedAt: new Date(now - 1000).toISOString() });
    const future = new Date(now + 3600000).toISOString();
    await poseTelemetryService.ingest(first);
    await poseTelemetryService.ingest({ ...first, nodeId: 'future-node', observedAt: future });

    const data = await poseTelemetryService.getEvents(query());
    expect(data).toMatchObject({ total: 1, observationCount: 1, chainVerifiedEvents: 0 });
    expect(data.events[0]).toMatchObject({ observerCount: 1, observationCount: 1,
      observerNodeIds: [first.nodeId], lastReportedAt: first.observedAt, canonicalStatus: 'unverified' });
    expect(await PoseObservation.countDocuments()).toBe(2);
    await PoseObservation.updateOne({ nodeId: 'future-node' }, { $set: { observedAt: new Date(now - 500) } });
    const recovered = await poseTelemetryService.getEvents(query());
    expect(recovered.events[0]).toMatchObject({ observerCount: 2, observationCount: 2 });
  });

  it.each(['report', 'event'])('recovers a valid repeated observation after an initially future %s timestamp', async (futureField) => {
    const now = Date.now();
    const validTime = new Date(now - 60000).toISOString();
    const futureTime = new Date(now + 86400000).toISOString();
    const valid = payload({ observedAt: validTime, poseEvents: [poseEvent({ eventAt: validTime })] });
    const first = futureField === 'report' ? { ...valid, observedAt: futureTime }
      : { ...valid, poseEvents: [{ ...valid.poseEvents[0], eventAt: futureTime }] };
    await networkNoiseService.ingest(first);
    expect((await poseTelemetryService.getEvents(query())).total).toBe(0);
    const original = await PoseObservation.findOne().lean();
    expect(original).not.toBeNull();
    await networkNoiseService.ingest({ ...valid, sequence: valid.sequence + 1 });
    const data = await poseTelemetryService.getEvents(query());
    expect(data).toMatchObject({ total: 1, observationCount: 1, chainVerifiedEvents: 0 });
    expect(data.events[0]).toMatchObject({ observerCount: 1, canonicalStatus: 'unverified' });
    const repaired = await PoseObservation.findOne().lean();
    expect(repaired?.observedAt.toISOString()).toBe(validTime);
    expect(repaired?.eventAt.toISOString()).toBe(validTime);
    expect(repaired?.expiresAt).toEqual(original?.expiresAt);
    expect(repaired?.receivedAt).toEqual(original?.receivedAt);
    expect(await PoseObservation.countDocuments()).toBe(1);
  });

  it('never combines timestamps from separate reports or overwrites an already visible report', async () => {
    const now = Date.now();
    const validTime = new Date(now - 60000).toISOString();
    const futureTime = new Date(now + 86400000).toISOString();
    const source = payload({ observedAt: futureTime, poseEvents: [poseEvent({ eventAt: futureTime })] });
    await poseTelemetryService.ingest(source);
    await poseTelemetryService.ingest({ ...source, observedAt: validTime });
    await poseTelemetryService.ingest({ ...source, poseEvents: [{ ...source.poseEvents[0], eventAt: validTime }] });
    expect((await poseTelemetryService.getEvents(query())).total).toBe(0);
    const valid = { ...source, observedAt: validTime, poseEvents: [{ ...source.poseEvents[0], eventAt: validTime }] };
    await poseTelemetryService.ingest(valid);
    await poseTelemetryService.ingest({ ...valid, observedAt: new Date(now - 30000).toISOString() });
    expect((await PoseObservation.findOne().lean())?.observedAt.toISOString()).toBe(validTime);
    expect((await poseTelemetryService.getEvents(query())).total).toBe(1);
  });

  it('does not repair a different incomplete event sharing the same local event ID', async () => {
    const now = Date.now();
    const validTime = new Date(now - 60000).toISOString();
    const event = poseEvent({ eventAt: validTime, eventBlockHeight: null });
    const source = payload({ observedAt: new Date(now + 86400000).toISOString(), poseEvents: [event] });
    await poseTelemetryService.ingest(source);
    await poseTelemetryService.ingest({ ...source, observedAt: validTime,
      poseEvents: [{ ...event, penalty: event.penalty! + 1 }] });
    expect((await poseTelemetryService.getEvents(query())).total).toBe(0);
    expect((await PoseObservation.findOne().lean())?.penalty).toBe(event.penalty);
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
    await expect(networkNoiseService.ingest(first)).rejects.toBeInstanceOf(NetworkNoiseSequenceConflict);
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
