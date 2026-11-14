import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { syncService } from '../src/services/sync.service';
import { rpcService } from '../src/services/rpc.service';
import { realtimeService } from '../src/services/realtime.service';
import { telegramService } from '../src/services/telegram.service';
import { Address } from '../src/models/Address';
import { Block } from '../src/models/Block';
import { SyncState } from '../src/models/SyncState';
import { Transaction } from '../src/models/Transaction';

// This suite requires an explicitly supplied disposable localhost database.
// The normal unit suite must never connect to an operator's configured MongoDB.
const baseUri = process.env.TEST_POSE_MONGO_URI;

const A = 'DNSSwp3CWfyus5h8TSBvJHFoTUASQCF8Rj';
const B = 'D8e1nUDayNHvXSYZPv1QECNcSgCxgsXw9d';
const STALE = 'D9NofFTND226dT475V33QaHU9LKHK7UwVe';
const MINUTE = 60_000;

const hashOf = (height: number) => height.toString(16).padStart(64, 'c');
const pay = (n: number, coins: number, address: string) => ({
  value: coins, valueSat: coins * 100_000_000, n,
  scriptPubKey: { asm: '', hex: '76a914' + '00'.repeat(20) + '88ac', type: 'pubkeyhash', addresses: [address] },
});
const coinbase = (height: number, address: string) => ({
  txid: `cb${height}`.padStart(64, '0'), version: 3, size: 100, locktime: 0,
  vin: [{ coinbase: '03aa0d02', sequence: 0 }], vout: [pay(0, 1000, address)],
});
// Three blocks, each a single coinbase: A, B, A.
const BLOCKS = [A, B, A].map((address, height) => ({
  hash: hashOf(height), confirmations: 1, size: 300, height, version: 1, merkleroot: 'm'.repeat(64),
  tx: [coinbase(height, address)], time: 1_800_000_000 + height * 150, mediantime: 1_800_000_000 + height * 150,
  nonce: 0, bits: '1d00ffff', difficulty: 1, chainwork: '00', nTx: 1,
  ...(height > 0 ? { previousblockhash: hashOf(height - 1) } : {}),
}));

/**
 * The daemon, answering from the fixture up to `tip`. `failBlock` makes that block's first two fetches
 * fail: the indexer retries a failed verbose fetch once with a lighter one.
 */
function mockDaemon(tip: number, options: { failBlock?: number } = {}) {
  let failures = 0;
  const count = vi.spyOn(rpcService, 'getBlockCount').mockResolvedValue(tip);
  vi.spyOn(rpcService, 'getBlockHash').mockImplementation(async (height: number) => hashOf(height));
  vi.spyOn(rpcService, 'getBlock').mockImplementation(async (hash: string) => {
    const block = BLOCKS.find((candidate) => candidate.hash === hash);
    if (!block) throw new Error(`unknown block ${hash}`);
    if (block.height === options.failBlock && failures < 2) {
      failures += 1;
      throw new Error('daemon unavailable');
    }
    return structuredClone(block);
  });
  return count;
}

const syncState = () => SyncState.findOne({ key: 'main' }).lean<Record<string, unknown>>();
const balanceOf = async (address: string) => {
  const doc = await Address.findOne({ address }).lean<{ balanceSat?: unknown }>();
  return doc ? String(doc.balanceSat) : null;
};
const ago = (ms: number) => new Date(Date.now() - ms);

const internals = syncService as unknown as {
  stopRequested: boolean;
  ADDRESS_BULK_FLUSH_THRESHOLD: number;
  rebuildAddressIndexFromTransactions: () => Promise<void>;
};

describe.skipIf(!baseUri)('the sync lock and the service start, with disposable MongoDB', () => {
  beforeAll(async () => {
    if (!baseUri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/deftrack_pose_test_[a-f0-9]+$/.test(baseUri)) {
      throw new Error('TEST_POSE_MONGO_URI must name an isolated localhost test database');
    }
    // Own database, so it cannot collide with other integration suites that may run at the same time.
    await mongoose.connect(`${baseUri}sl`, { serverSelectionTimeoutMS: 5000 });
    await Promise.all([Block.init(), Transaction.init(), Address.init(), SyncState.init()]);
  });
  beforeEach(async () => {
    internals.stopRequested = false;
    vi.spyOn(realtimeService, 'publishNewBlock').mockImplementation(() => undefined);
    vi.spyOn(realtimeService, 'publishNewTx').mockImplementation(() => undefined);
    vi.spyOn(realtimeService, 'publishSyncStatus').mockImplementation(() => undefined);
    vi.spyOn(telegramService, 'notifyNewBlock').mockImplementation(() => undefined);
    await Promise.all([Block.deleteMany({}), Transaction.deleteMany({}), Address.deleteMany({}), SyncState.deleteMany({})]);
  });
  afterAll(async () => {
    internals.stopRequested = false;
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  /** A lock held by a run that last showed a heartbeat at `heartbeatAt` (null: never). */
  async function heldLock(heartbeatAt: Date | null) {
    const startedAt = ago(30 * MINUTE);
    await SyncState.create({
      key: 'main', lastSyncedHeight: -1, lastSyncedHash: '', addressIndexVersion: 3, satoshiDataVersion: 3,
      isRunning: true, startedAt, heartbeatAt,
    });
    // A balance only a rebuild removes: no stored transaction pays this address.
    await Address.create({ address: STALE, balanceSat: '123', totalReceivedSat: '123', totalSentSat: '0', txCount: 1 });
    return startedAt;
  }

  it('takes over a lock whose holder has shown no heartbeat for over 10 minutes, and rebuilds first', async () => {
    mockDaemon(2);
    await heldLock(ago(11 * MINUTE));

    await expect(syncService.sync()).resolves.toBeUndefined();

    expect(await balanceOf(STALE)).toBeNull();
    expect(await balanceOf(A)).toBe('200000000000');
    expect(await syncState()).toMatchObject({ isRunning: false, addressRebuildRequired: false, lastSyncedHeight: 2, error: null });
  });

  it('takes over a held lock that never had a heartbeat', async () => {
    mockDaemon(2);
    await heldLock(null);

    await expect(syncService.sync()).resolves.toBeUndefined();

    expect(await balanceOf(STALE)).toBeNull();
    expect(await syncState()).toMatchObject({ isRunning: false, lastSyncedHeight: 2 });
  });

  it('leaves a lock with a recent heartbeat alone, without an error', async () => {
    const daemon = mockDaemon(2);
    const startedAt = await heldLock(ago(1 * MINUTE));

    await expect(syncService.sync()).resolves.toBeUndefined();

    expect(daemon).not.toHaveBeenCalled();
    expect(await Block.countDocuments()).toBe(0);
    expect(await balanceOf(STALE)).toBe('123');
    expect(await syncState()).toMatchObject({ isRunning: true, startedAt });
  });

  it('when the error cannot be recorded, the run still ends quietly and the lock is taken over once it expires', async () => {
    mockDaemon(2, { failBlock: 1 });
    await SyncState.create({ key: 'main', lastSyncedHeight: -1, lastSyncedHash: '', addressIndexVersion: 3, satoshiDataVersion: 3 });
    const original = SyncState.findOneAndUpdate.bind(SyncState);
    let recordFailed = false;
    vi.spyOn(SyncState, 'findOneAndUpdate').mockImplementation(((filter: unknown, update: { error?: unknown }, ...rest: unknown[]) => {
      if (!recordFailed && typeof update?.error === 'string') {
        recordFailed = true;
        throw new Error('state write failed');
      }
      return (original as (...args: unknown[]) => unknown)(filter, update, ...rest);
    }) as never);

    await expect(syncService.sync()).resolves.toBeUndefined();
    expect(recordFailed).toBe(true);
    // The lock could not be released, so it is still held.
    expect(await syncState()).toMatchObject({ isRunning: true });

    // Not yet expired: the next run leaves it alone.
    await expect(syncService.sync()).resolves.toBeUndefined();
    expect(await Block.countDocuments({ height: { $gte: 1 } })).toBe(0);

    // Expired: the next run takes it over and finishes the chain.
    await SyncState.updateOne({ key: 'main' }, { heartbeatAt: ago(11 * MINUTE) });
    await expect(syncService.sync()).resolves.toBeUndefined();
    expect(await syncState()).toMatchObject({ isRunning: false, lastSyncedHeight: 2, addressRebuildRequired: false });
    expect(await balanceOf(B)).toBe('100000000000');
  });

  it('a rebuild keeps the lock alive with a heartbeat while it writes', async () => {
    mockDaemon(2);
    await SyncState.create({ key: 'main', lastSyncedHeight: -1, lastSyncedHash: '', addressIndexVersion: 3, satoshiDataVersion: 3 });
    await syncService.sync();
    await SyncState.updateOne({ key: 'main' }, { heartbeatAt: ago(11 * MINUTE) });
    const flushBefore = internals.ADDRESS_BULK_FLUSH_THRESHOLD;
    internals.ADDRESS_BULK_FLUSH_THRESHOLD = 1;
    const beats: Date[] = [];
    const record = (update: unknown) => {
      const fields = update as { heartbeatAt?: Date; $set?: { heartbeatAt?: Date } };
      const at = fields?.heartbeatAt ?? fields?.$set?.heartbeatAt;
      if (at) beats.push(at);
    };
    const updateOne = SyncState.updateOne.bind(SyncState);
    vi.spyOn(SyncState, 'updateOne').mockImplementation(((filter: unknown, update: unknown, ...rest: unknown[]) => {
      record(update);
      return (updateOne as (...args: unknown[]) => unknown)(filter, update, ...rest);
    }) as never);
    const findOneAndUpdate = SyncState.findOneAndUpdate.bind(SyncState);
    vi.spyOn(SyncState, 'findOneAndUpdate').mockImplementation(((filter: unknown, update: unknown, ...rest: unknown[]) => {
      record(update);
      return (findOneAndUpdate as (...args: unknown[]) => unknown)(filter, update, ...rest);
    }) as never);

    try {
      await internals.rebuildAddressIndexFromTransactions();
    } finally {
      internals.ADDRESS_BULK_FLUSH_THRESHOLD = flushBefore;
    }

    // Three coinbases, one balance write each: at least one heartbeat per write.
    expect(beats.length).toBeGreaterThanOrEqual(3);
    const state = await syncState();
    expect(Date.now() - new Date(state?.heartbeatAt as Date).getTime()).toBeLessThan(MINUTE);
  });

  it('a start that failed can be tried again', async () => {
    mockDaemon(1);
    await SyncState.create({ key: 'main', lastSyncedHeight: -1, lastSyncedHash: '', addressIndexVersion: 3, satoshiDataVersion: 3 });
    const findOne = SyncState.findOne.bind(SyncState);
    let failed = false;
    vi.spyOn(SyncState, 'findOne').mockImplementation(((...args: unknown[]) => {
      if (!failed) {
        failed = true;
        throw new Error('database not ready');
      }
      return (findOne as (...a: unknown[]) => unknown)(...args);
    }) as never);
    const intervals = vi.spyOn(globalThis, 'setInterval');

    try {
      await expect(syncService.start()).rejects.toThrow('database not ready');
      await syncService.start();
      expect(await syncState()).toMatchObject({ lastSyncedHeight: 1 });
    } finally {
      await syncService.stop();
      for (const result of intervals.mock.results) clearInterval(result.value as ReturnType<typeof setInterval>);
    }
  });

  it('a service stopped while it is starting sets up no periodic sync', async () => {
    await SyncState.create({ key: 'main', lastSyncedHeight: -1, lastSyncedHash: '', addressIndexVersion: 3, satoshiDataVersion: 3 });
    mockDaemon(1);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached = false;
    vi.spyOn(rpcService, 'getBlockCount').mockImplementation(async () => {
      reached = true;
      await gate;
      return 1;
    });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const periodic = () => intervals.mock.calls.filter((call) => call[1] === config.sync.intervalMs).length;

    const starting = syncService.start();
    try {
      await vi.waitFor(() => expect(reached).toBe(true));
      const stopping = syncService.stop();
      release();
      await stopping;
      await starting;
      expect(periodic()).toBe(0);
    } finally {
      release();
      await starting.catch(() => undefined);
      await syncService.stop();
      for (const result of intervals.mock.results) clearInterval(result.value as ReturnType<typeof setInterval>);
    }
  });

  it('start() twice sets up one periodic sync, and a stopped service can start again', async () => {
    mockDaemon(1);
    await SyncState.create({ key: 'main', lastSyncedHeight: -1, lastSyncedHash: '', addressIndexVersion: 3, satoshiDataVersion: 3 });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const created: Array<ReturnType<typeof setInterval>> = [];
    const periodic = () => intervals.mock.calls.filter((call) => call[1] === config.sync.intervalMs).length;

    try {
      await Promise.all([syncService.start(), syncService.start()]);
      for (const result of intervals.mock.results) created.push(result.value as ReturnType<typeof setInterval>);
      expect(periodic()).toBe(1);
      expect(await syncState()).toMatchObject({ lastSyncedHeight: 1 });

      await syncService.stop();
      mockDaemon(2);
      await syncService.start();
      for (const result of intervals.mock.results) created.push(result.value as ReturnType<typeof setInterval>);
      expect(periodic()).toBe(2);
      expect(await syncState()).toMatchObject({ lastSyncedHeight: 2, isRunning: false });
    } finally {
      await syncService.stop();
      for (const id of created) clearInterval(id);
    }
  });
});
