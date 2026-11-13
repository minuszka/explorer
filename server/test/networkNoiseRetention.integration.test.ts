import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PoseObservation } from '../src/models/PoseObservation';
import { NetworkNoiseNodeState } from '../src/models/NetworkNoiseNodeState';
import { NetworkNoiseObservation } from '../src/models/NetworkNoiseObservation';
import { NetworkNoiseBaseline, NetworkNoiseBatch } from '../src/models/NetworkNoiseBatch';
import { isSettled, networkNoiseBatchService } from '../src/services/networkNoiseBatch.service';
import { networkNoiseService } from '../src/services/networkNoise.service';
import { addToSettledRanges, networkNoiseRetentionService } from '../src/services/networkNoiseRetention.service';
import { logger } from '../src/utils/logger';
import { poseEvent, posePayload } from './fixtures/poseTelemetry';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('settled sequence ranges', () => {
  it('merges new sequences into ascending, non-adjacent ranges', () => {
    expect(addToSettledRanges([], [])).toEqual([]);
    expect(addToSettledRanges([], [12, 10, 11])).toEqual([{ from: 10, to: 12 }]);
    expect(addToSettledRanges([{ from: 10, to: 12 }], [13, 15])).toEqual([{ from: 10, to: 13 }, { from: 15, to: 15 }]);
    expect(addToSettledRanges([{ from: 10, to: 12 }, { from: 14, to: 15 }], [13])).toEqual([{ from: 10, to: 15 }]);
    expect(addToSettledRanges([{ from: 10, to: 12 }], [9, 11])).toEqual([{ from: 9, to: 12 }]);
  });

  it('tells a recorded sequence from any other', () => {
    const ranges = [{ from: 10, to: 12 }, { from: 20, to: 20 }];
    expect([9, 10, 12, 13, 19, 20, 21].map((sequence) => isSettled(ranges, sequence)))
      .toEqual([false, true, true, false, false, true, false]);
    expect(isSettled(undefined, 10)).toBe(false);
    expect(isSettled(null, 10)).toBe(false);
  });
});

// This suite requires an explicitly supplied disposable localhost database.
// The normal unit suite must never connect to an operator's configured MongoDB.
const uri = process.env.TEST_POSE_MONGO_URI;
describe.skipIf(!uri)('Network noise receipt retention with disposable MongoDB', () => {
  beforeAll(async () => {
    if (!uri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/deftrack_pose_test_[a-f0-9]+$/.test(uri)) {
      throw new Error('TEST_POSE_MONGO_URI must name an isolated localhost test database');
    }
    // Own database: the telemetry suite clears the same collections and may run at the same time.
    await mongoose.connect(`${uri}de`, { serverSelectionTimeoutMS: 5000 });
    await Promise.all([PoseObservation.init(), NetworkNoiseNodeState.init(), NetworkNoiseObservation.init(),
      NetworkNoiseBaseline.init(), NetworkNoiseBatch.init()]);
  });
  beforeEach(async () => {
    await Promise.all([PoseObservation.deleteMany({}), NetworkNoiseNodeState.deleteMany({}),
      NetworkNoiseObservation.deleteMany({}), NetworkNoiseBaseline.deleteMany({}), NetworkNoiseBatch.deleteMany({})]);
  });
  afterAll(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  type Payload = Parameters<typeof networkNoiseService.ingest>[0];
  function signal(fingerprint: string) {
    const at = new Date(Date.now() - 1000).toISOString();
    return { type: 'stale_peer', fingerprint, count: 1, firstSeenAt: at, lastSeenAt: at };
  }
  // A schema 1 agent batch; the fixtures' defaults give node-a.
  function batch(sequence: number, overrides: { nodeId?: string; signals?: ReturnType<typeof signal>[] } = {}) {
    const { poseEvents: _events, ...common } = posePayload({ sequence, observedAt: new Date().toISOString(),
      snapshot: { ip: '198.51.100.40', blockHeight: 100 + sequence }, signals: [], ...overrides });
    return { ...common, schemaVersion: 1 as const, agentVersion: '1.0.0' };
  }
  // A schema 2 batch with one PoSe event; its receipt refuses different content.
  function v2Batch(sequence: number, penalty = 145) {
    return posePayload({ sequence, observedAt: new Date().toISOString(),
      poseEvents: [poseEvent({ eventAt: new Date(Date.now() - 60000).toISOString(), penalty })] });
  }
  // Schema 1 builds new content on every attempt; schema 2 repeats the batch exactly.
  const attemptsOn: [string, (sequence: number) => Payload[]][] = [
    ['schema 1', (sequence) => [batch(sequence, { signals: [signal('first-attempt')] }), batch(sequence, { signals: [signal('second-attempt')] })]],
    ['schema 2', (sequence) => { const same = v2Batch(sequence); return [same, same]; }],
  ];
  // Backdates when the receipts were last touched, as time passing would.
  async function age(sequences: number[], days: number, nodeId = 'node-a') {
    const updatedAt = new Date(Date.now() - days * DAY_MS);
    await NetworkNoiseBatch.updateMany({ nodeId, sequence: { $in: sequences } }, { $set: { updatedAt } }, { timestamps: false });
  }
  const receipts = async (nodeId = 'node-a') =>
    (await NetworkNoiseBatch.find({ nodeId }).sort({ sequence: 1 }).lean()).map((receipt) => receipt.sequence);
  const settled = async (nodeId = 'node-a') =>
    ((await NetworkNoiseBaseline.findOne({ nodeId }).lean())?.settledRanges ?? []).map(({ from, to }) => [from, to]);
  const isComplete = async (sequence: number) =>
    (await NetworkNoiseBatch.findOne({ nodeId: 'node-a', sequence }).lean())?.complete;
  const lastSequence = async (nodeId = 'node-a') => (await NetworkNoiseNodeState.findOne({ nodeId }).lean())?.lastSequence;
  const prune = () => networkNoiseRetentionService.pruneOnce(new Date(), 30);
  // Runs `during` right after the next execution of a query on `model[method]`,
  // before the caller sees its result.
  function afterNextQuery(model: typeof NetworkNoiseBaseline | typeof NetworkNoiseBatch,
    method: 'find' | 'findOneAndUpdate', during: () => Promise<void>) {
    const original = model[method].bind(model) as (...args: unknown[]) => mongoose.Query<unknown, unknown>;
    return vi.spyOn(model, method).mockImplementationOnce(((...args: unknown[]) => {
      const query = original(...args);
      const exec = query.exec.bind(query);
      query.exec = async () => { const result = await exec(); await during(); return result; };
      return query;
    }) as never);
  }
  // Runs a pass in which `item` reaches its receipt after the pass has listed the
  // settled receipts, and goes on only once the pass has finished.
  async function ingestDuringPass(item: Payload) {
    let request!: Promise<unknown>;
    let finishPass!: () => void;
    const passFinished = new Promise<void>((resolve) => { finishPass = resolve; });
    const receiptReached = new Promise<void>((resolve) => {
      afterNextQuery(NetworkNoiseBatch, 'findOneAndUpdate', async () => { resolve(); await passFinished; });
    });
    afterNextQuery(NetworkNoiseBatch, 'find', async () => {
      request = networkNoiseService.ingest(item);
      await receiptReached;
    });
    const result = await prune();
    finishPass();
    return { result, request };
  }
  // What a restore does: the dumped documents replace the collections.
  async function restore(baselines: object[], batches: object[]) {
    await Promise.all([NetworkNoiseBaseline.deleteMany({}), NetworkNoiseBatch.deleteMany({})]);
    await Promise.all([NetworkNoiseBaseline.insertMany(baselines), NetworkNoiseBatch.insertMany(batches)]);
  }

  it('records settled sequences in one pass, deletes their receipts in a later pass, and keeps them refused', async () => {
    const old = batch(10, { signals: [signal('old-signal')] });
    await networkNoiseService.ingest(old);
    await networkNoiseService.ingest(batch(11));
    await networkNoiseService.ingest(batch(12, { signals: [signal('current-signal')] }));
    await age([10, 11], 40);

    expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect(await receipts()).toEqual([10, 11, 12]);
    expect(await settled()).toEqual([[10, 11]]);
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 2 });
    expect(await receipts()).toEqual([12]);
    expect(await settled()).toEqual([[10, 11]]);
    expect((await NetworkNoiseBaseline.findOne({ nodeId: 'node-a' }).lean())?.legacySequence).toBe(-1);

    // The pruned sequences cannot come back, with the same or with different content.
    expect(await networkNoiseService.ingest(old)).toMatchObject({ duplicate: true });
    expect(await networkNoiseService.ingest(batch(11, { signals: [signal('new-content')] }))).toMatchObject({ duplicate: true });
    expect(await NetworkNoiseObservation.countDocuments()).toBe(2);
    expect(await receipts()).toEqual([12]);
    expect(await lastSequence()).toBe(12);
    // Later sequences continue as before.
    expect(await networkNoiseService.ingest(batch(13))).toMatchObject({ duplicate: false });
    expect(await receipts()).toEqual([12, 13]);
    expect(await lastSequence()).toBe(13);
  });

  it('settles an aged receipt above a sequence still inside the period without waiting for it', async () => {
    for (const sequence of [50, 99, 100]) await networkNoiseService.ingest(batch(sequence));
    await age([50, 100], 40);

    expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect(await settled()).toEqual([[50, 50], [100, 100]]);
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 2 });
    expect(await receipts()).toEqual([99]);

    // Once the sequence inside the period ages out, it joins its neighbour.
    await age([99], 40);
    expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect(await settled()).toEqual([[50, 50], [99, 100]]);
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 1 });
    expect(await receipts()).toEqual([]);
  });

  it('drops an incomplete batch left untouched for the period and answers its retry as a duplicate', async () => {
    const stuck = batch(20, { signals: [signal('stuck')] });
    const complete = vi.spyOn(networkNoiseBatchService, 'complete').mockRejectedValueOnce(new Error('connection lost'));
    await expect(networkNoiseService.ingest(stuck)).rejects.toThrow('connection lost');
    complete.mockRestore();
    await networkNoiseService.ingest(batch(21));
    expect(await isComplete(20)).toBe(false);
    await age([20], 40);

    expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect(await settled()).toEqual([[20, 20]]);
    // The retry is refused without touching the receipt, which goes in the next pass.
    expect(await networkNoiseService.ingest(stuck)).toMatchObject({ duplicate: true });
    expect(await lastSequence()).toBe(21);
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 1 });
    expect(await receipts()).toEqual([21]);
  });

  it('answers a long-abandoned retry that reaches its receipt during the recording pass as a duplicate', async () => {
    const stuck = batch(20, { signals: [signal('stuck')] });
    const complete = vi.spyOn(networkNoiseBatchService, 'complete').mockRejectedValueOnce(new Error('connection lost'));
    await expect(networkNoiseService.ingest(stuck)).rejects.toThrow('connection lost');
    complete.mockRestore();
    await age([20], 40);

    // The same answer as a retry arriving just after the pass.
    const { result, request } = await ingestDuringPass(stuck);
    expect(result).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect(await request).toMatchObject({ duplicate: true });
    expect(await settled()).toEqual([[20, 20]]);
  });

  it('clears every receipt of a node that stopped reporting and accepts its next sequence', async () => {
    await networkNoiseService.ingest(batch(30));
    await networkNoiseService.ingest(batch(31));
    await age([30, 31], 40);

    expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 2 });
    expect(await receipts()).toEqual([]);
    expect(await settled()).toEqual([[30, 31]]);
    expect(await networkNoiseService.ingest(batch(31))).toMatchObject({ duplicate: true });
    expect(await networkNoiseService.ingest(batch(32))).toMatchObject({ duplicate: false });
    expect(await receipts()).toEqual([32]);
  });

  it('keeps a receipt that a request touched inside the period', async () => {
    const first = batch(10, { signals: [signal('kept')] });
    await networkNoiseService.ingest(first);
    await networkNoiseService.ingest(batch(11));
    await age([10], 40);
    expect(await networkNoiseService.ingest(first)).toMatchObject({ duplicate: true });

    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 0 });
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 0 });
    expect(await receipts()).toEqual([10, 11]);
    expect(await settled()).toEqual([]);
  });

  it('treats each node on its own', async () => {
    await networkNoiseService.ingest(batch(10));
    await networkNoiseService.ingest(batch(10, { nodeId: 'node-b' }));
    await age([10], 40);

    expect(await prune()).toEqual({ nodes: 2, recorded: 1, deleted: 0 });
    expect(await prune()).toEqual({ nodes: 2, recorded: 0, deleted: 1 });
    expect(await receipts()).toEqual([]);
    expect(await settled()).toEqual([[10, 10]]);
    expect(await receipts('node-b')).toEqual([10]);
    expect(await settled('node-b')).toEqual([]);
  });

  it('skips a node that has no baseline to record its sequences', async () => {
    await networkNoiseService.ingest(batch(10));
    await NetworkNoiseBaseline.deleteMany({ nodeId: 'node-a' });
    await age([10], 40);

    expect(await prune()).toEqual({ nodes: 0, recorded: 0, deleted: 0 });
    expect(await prune()).toEqual({ nodes: 0, recorded: 0, deleted: 0 });
    expect(await receipts()).toEqual([10]);
  });

  it('does nothing while every receipt is inside the period or none exists', async () => {
    expect(await prune()).toEqual({ nodes: 0, recorded: 0, deleted: 0 });
    await networkNoiseService.ingest(batch(10));
    await networkNoiseService.ingest(batch(11));
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 0 });
    expect(await receipts()).toEqual([10, 11]);
    expect(await settled()).toEqual([]);
  });

  it.each([[0, 1], [0, 2], [0, 3], [1, 1], [1, 2], [2, 1], [3, 2]])('keeps every sequence refused after restoring a backup that read the receipts before the baselines, %i passes in and %i passes between', async (earlierPasses, passesBetween) => {
    const sent = [10, 11, 12].map((sequence) => batch(sequence));
    for (const item of sent) await networkNoiseService.ingest(item);
    await age([10, 11], 40);
    for (let pass = 0; pass < earlierPasses; pass++) await prune();

    // The order of the supported backup, with any number of passes during the dump.
    const dumpedReceipts = await NetworkNoiseBatch.find({}).lean();
    for (let pass = 0; pass < passesBetween; pass++) await prune();
    const dumpedBaselines = await NetworkNoiseBaseline.find({}).lean();

    await restore(dumpedBaselines, dumpedReceipts);
    for (const item of sent) {
      expect(await networkNoiseService.ingest(item), `sequence ${item.sequence}`).toMatchObject({ duplicate: true });
    }
    expect(await lastSequence()).toBe(12);
  });

  it.each([0, 1, 2])('keeps every sequence refused after restoring a dump that read the baselines first with one pass during it, %i passes in', async (earlierPasses) => {
    const sent = [10, 11, 12].map((sequence) => batch(sequence));
    for (const item of sent) await networkNoiseService.ingest(item);
    await age([10, 11], 40);
    for (let pass = 0; pass < earlierPasses; pass++) await prune();

    // A dump made by hand may read in this order; one pass during it is still safe.
    const dumpedBaselines = await NetworkNoiseBaseline.find({}).lean();
    await prune();
    const dumpedReceipts = await NetworkNoiseBatch.find({}).lean();

    await restore(dumpedBaselines, dumpedReceipts);
    for (const item of sent) {
      expect(await networkNoiseService.ingest(item), `sequence ${item.sequence}`).toMatchObject({ duplicate: true });
    }
    expect(await lastSequence()).toBe(12);
  });

  it.each([['identical', 145], ['different', 146]])('does not process %s schema 2 content under a sequence whose receipt retention deleted while the request held the old record', async (_content, penalty) => {
    await networkNoiseService.ingest(v2Batch(10));
    await networkNoiseService.ingest(batch(11));
    await age([10], 40);
    const observationsBefore = await PoseObservation.countDocuments();

    // The request reads the baseline, then retention records the sequence and deletes
    // the receipt before the request reaches it.
    afterNextQuery(NetworkNoiseBaseline, 'findOneAndUpdate', async () => {
      expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
      expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 1 });
    });
    expect(await networkNoiseService.ingest(v2Batch(10, penalty))).toMatchObject({ duplicate: true });
    expect(await PoseObservation.countDocuments()).toBe(observationsBefore);
    expect(await lastSequence()).toBe(11);

    // The recreated receipt is incomplete. Retrying does not make it count, and once
    // settled it goes like any other receipt.
    expect(await isComplete(10)).toBe(false);
    expect(await networkNoiseService.ingest(v2Batch(10, penalty))).toMatchObject({ duplicate: true });
    expect(await PoseObservation.countDocuments()).toBe(observationsBefore);
    await age([10], 40);
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 1 });
    expect(await receipts()).toEqual([11]);
    expect(await settled()).toEqual([[10, 10]]);
  });

  it.each([1, 2])('refuses a schema 1 resend when %i passes settled its sequence after the request read the baseline', async (passes) => {
    await networkNoiseService.ingest(batch(10, { signals: [signal('original')] }));
    await networkNoiseService.ingest(batch(11));
    await age([10], 40);

    afterNextQuery(NetworkNoiseBaseline, 'findOneAndUpdate', async () => {
      for (let pass = 0; pass < passes; pass++) await prune();
    });
    expect(await networkNoiseService.ingest(batch(10, { signals: [signal('resent')] }))).toMatchObject({ duplicate: true });
    expect(await NetworkNoiseObservation.countDocuments()).toBe(1);
    expect(await lastSequence()).toBe(11);
  });

  it('does not count a receipt created during the pass as settled', async () => {
    await networkNoiseService.ingest(batch(10));
    await age([10], 40);

    // The pass has listed the settled receipts when a new sequence arrives and completes.
    const fresh = batch(11);
    afterNextQuery(NetworkNoiseBatch, 'find', async () => {
      expect(await networkNoiseService.ingest(fresh)).toMatchObject({ duplicate: false });
    });
    expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect(await settled()).toEqual([[10, 10]]);
    expect(await receipts()).toEqual([10, 11]);
    expect(await networkNoiseService.ingest(fresh)).toMatchObject({ duplicate: true });
    expect(await lastSequence()).toBe(11);
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 1 });
    expect(await receipts()).toEqual([11]);
  });

  it('keeps a recorded receipt that a request touched before the deleting pass', async () => {
    await networkNoiseService.ingest(batch(10));
    await networkNoiseService.ingest(batch(11));
    await age([10], 40);
    expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });

    // A request that reached the receipt bumps its timestamp; it is inside the
    // period again and stays until it has been untouched for the whole period.
    await NetworkNoiseBatch.updateOne({ nodeId: 'node-a', sequence: 10 }, { $set: { complete: true } });
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 0 });
    expect(await receipts()).toEqual([10, 11]);
    await age([10], 40);
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 1 });
    expect(await receipts()).toEqual([11]);
  });

  it('accepts a never-seen lower sequence after the receipt above it has gone', async () => {
    await networkNoiseService.ingest(batch(10));
    await age([10], 40);
    await prune();
    await prune();
    expect(await receipts()).toEqual([]);

    const late = batch(9, { signals: [signal('late')] });
    expect(await networkNoiseService.ingest(late)).toMatchObject({ duplicate: false });
    expect(await NetworkNoiseObservation.countDocuments()).toBe(1);
    expect(await isComplete(9)).toBe(true);
    expect(await lastSequence()).toBe(10);
    expect(await networkNoiseService.ingest(late)).toMatchObject({ duplicate: true });
    expect(await settled()).toEqual([[10, 10]]);
  });

  it.each(attemptsOn)('processes a never-seen %s batch that reaches its receipt during a pass', async (_schema, attempts) => {
    const [late] = attempts(9);
    await networkNoiseService.ingest(batch(10));
    await age([10], 40);

    const { result, request } = await ingestDuringPass(late);
    expect(result).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect(await settled()).toEqual([[10, 10]]);
    expect(await request).toMatchObject({ duplicate: false });
    expect(await isComplete(9)).toBe(true);
    expect(await lastSequence()).toBe(10);
  });

  it.each(attemptsOn)('processes a never-seen %s batch whose request held an old baseline across two passes', async (_schema, attempts) => {
    const [late] = attempts(9);
    await networkNoiseService.ingest(batch(10));
    await age([10], 40);

    afterNextQuery(NetworkNoiseBaseline, 'findOneAndUpdate', async () => {
      expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
      expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 1 });
    });
    expect(await networkNoiseService.ingest(late)).toMatchObject({ duplicate: false });
    expect(await isComplete(9)).toBe(true);
    expect(await receipts()).toEqual([9]);
  });

  it.each(attemptsOn)('keeps an incomplete %s batch retryable across later passes', async (_schema, attempts) => {
    const [first, retry] = attempts(9);
    await networkNoiseService.ingest(batch(10));
    await age([10], 40);

    const complete = vi.spyOn(networkNoiseBatchService, 'complete').mockRejectedValueOnce(new Error('connection lost'));
    const { request } = await ingestDuringPass(first);
    await expect(request).rejects.toThrow('connection lost');
    complete.mockRestore();
    expect(await isComplete(9)).toBe(false);

    // Later passes go on with the other receipts and leave this one alone.
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 1 });
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 0 });
    expect(await receipts()).toEqual([9]);

    // Nor does a pass between the retry reaching the receipt and its second check
    // change the answer.
    afterNextQuery(NetworkNoiseBatch, 'findOneAndUpdate', async () => {
      expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 0 });
    });
    expect(await networkNoiseService.ingest(retry)).toMatchObject({ duplicate: false });
    expect(await isComplete(9)).toBe(true);
    expect(await networkNoiseService.ingest(retry)).toMatchObject({ duplicate: true });

    // Once settled it goes like any other receipt.
    await age([9], 40);
    expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 1 });
    expect(await receipts()).toEqual([]);
    expect(await settled()).toEqual([[9, 10]]);
  });

  it.each(attemptsOn)('stops recording at the range limit rather than close a gap, and an incomplete %s batch stays retryable', async (_schema, attempts) => {
    const [first, retry] = attempts(2);
    const complete = vi.spyOn(networkNoiseBatchService, 'complete').mockRejectedValueOnce(new Error('connection lost'));
    await expect(networkNoiseService.ingest(first)).rejects.toThrow('connection lost');
    complete.mockRestore();
    // Sequences 1, 3, ... 1999 are recorded, one range each: as many as allowed.
    const atLimit = Array.from({ length: 1000 }, (_, index) => ({ from: 2 * index + 1, to: 2 * index + 1 }));
    await NetworkNoiseBaseline.updateOne({ nodeId: 'node-a' }, { $set: { settledRanges: atLimit, rangesRevision: 1 } });
    await networkNoiseService.ingest(batch(2001));
    await age([2001], 40);

    // The next settled sequence would go over the limit. The pass runs between the
    // retry reaching its receipt and its second check, records nothing and says so.
    const warn = vi.spyOn(logger, 'warn');
    afterNextQuery(NetworkNoiseBatch, 'findOneAndUpdate', async () => {
      expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 0 });
    });
    expect(await networkNoiseService.ingest(retry)).toMatchObject({ duplicate: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('node-a would need 1001 ranges'));
    warn.mockRestore();
    expect(await isComplete(2)).toBe(true);
    expect(await settled()).toEqual(atLimit.map(({ from, to }) => [from, to]));
    expect(await receipts()).toEqual([2, 2001]);
    // A never-seen sequence in a gap is still accepted.
    expect(await networkNoiseService.ingest(batch(4))).toMatchObject({ duplicate: false });
    expect(await isComplete(4)).toBe(true);

    // A sequence that only extends a range still fits.
    await networkNoiseService.ingest(batch(2000));
    await age([2000, 2001], 40);
    expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect((await settled()).at(-1)).toEqual([1999, 2001]);
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 2 });
    expect(await receipts()).toEqual([2, 4]);
  }, 30_000);

  it('does not let a batch that keeps failing hold back the receipts of later sequences', async () => {
    const failing = v2Batch(9);
    const failOnce = async () => {
      const complete = vi.spyOn(networkNoiseBatchService, 'complete').mockRejectedValueOnce(new Error('connection lost'));
      await expect(networkNoiseService.ingest(failing)).rejects.toThrow('connection lost');
      complete.mockRestore();
    };
    await failOnce();

    for (const sequence of [10, 11, 12, 13]) {
      await networkNoiseService.ingest(batch(sequence));
      await failOnce();
      await age((await receipts()).filter((held) => held !== 9 && held !== sequence), 40);
      await prune();
      await prune();
    }
    expect(await receipts()).toEqual([9, 13]);
    expect(await settled()).toEqual([[10, 12]]);
    expect(await isComplete(9)).toBe(false);

    expect(await networkNoiseService.ingest(failing)).toMatchObject({ duplicate: false });
    expect(await isComplete(9)).toBe(true);
  });

  it('does not let a pass holding an older record overwrite a newer one', async () => {
    const deleted = batch(10);
    await networkNoiseService.ingest(deleted);
    await networkNoiseService.ingest(batch(11));
    await networkNoiseService.ingest(batch(12));
    await age([10], 40);

    // A second server's passes record and delete sequence 10 while this pass still
    // holds the empty record it read at its start, and sequence 11 settles meanwhile.
    afterNextQuery(NetworkNoiseBaseline, 'find', async () => {
      expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
      expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 1 });
      await age([11], 40);
    });
    expect(await prune()).toEqual({ nodes: 1, recorded: 0, deleted: 0 });
    expect(await settled()).toEqual([[10, 10]]);
    expect(await networkNoiseService.ingest(deleted)).toMatchObject({ duplicate: true });

    // Its next run picks up what it could not write.
    expect(await prune()).toEqual({ nodes: 1, recorded: 1, deleted: 0 });
    expect(await settled()).toEqual([[10, 11]]);
  });
});
