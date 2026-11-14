import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import richlistRoutes, { invalidateRichlistCache } from '../src/routes/richlist.routes';
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
const C = 'DGK3yNxxedc2pvaPPwTbVBey2NmFC8FUGZ';
const REBUILD_COLLECTION = 'addresses_rebuild';

const hashOf = (height: number) => height.toString(16).padStart(64, 'f');
const pay = (n: number, coins: number, address: string) => ({
  value: coins, valueSat: coins * 100_000_000, n,
  scriptPubKey: { asm: '', hex: '76a914' + '00'.repeat(20) + '88ac', type: 'pubkeyhash', addresses: [address] },
});
// Three blocks, each a single coinbase: A, B, C.
const BLOCKS = [A, B, C].map((address, height) => ({
  hash: hashOf(height), confirmations: 1, size: 300, height, version: 1, merkleroot: 'm'.repeat(64),
  tx: [{ txid: `cb${height}`.padStart(64, '0'), version: 3, size: 100, locktime: 0, vin: [{ coinbase: '03aa0d02', sequence: 0 }], vout: [pay(0, 1000 * (height + 1), address)] }],
  time: 1_800_000_000 + height * 150, mediantime: 1_800_000_000 + height * 150, nonce: 0, bits: '1d00ffff',
  difficulty: 1, chainwork: '00', nTx: 1,
  ...(height > 0 ? { previousblockhash: hashOf(height - 1) } : {}),
}));

function mockDaemon(tip: number) {
  vi.spyOn(rpcService, 'getBlockCount').mockResolvedValue(tip);
  vi.spyOn(rpcService, 'getBlockHash').mockImplementation(async (height: number) => hashOf(height));
  vi.spyOn(rpcService, 'getBlock').mockImplementation(async (hash: string) => {
    const block = BLOCKS.find((candidate) => candidate.hash === hash);
    if (!block) throw new Error(`unknown block ${hash}`);
    return structuredClone(block);
  });
}

type Stored = { address: string; balanceSat: unknown; totalReceivedSat: unknown; totalSentSat: unknown; txCount: number };
async function storedAddresses() {
  const docs = await Address.find({}).lean<Stored[]>();
  return Object.fromEntries(docs.sort((a, b) => a.address.localeCompare(b.address)).map((doc) =>
    [doc.address, { balance: String(doc.balanceSat), received: String(doc.totalReceivedSat), sent: String(doc.totalSentSat), txCount: doc.txCount }]));
}
const collectionExists = async (name: string) =>
  (await mongoose.connection.db!.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;

/**
 * Takes over every model's bulkWrite while the address index is rebuilt. `hold` keeps the first
 * write back until `release()`; `fail` makes the first write throw.
 */
function interceptRebuildWrites(mode: 'hold' | 'fail') {
  const original = mongoose.Model.bulkWrite;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const state = { reached: false, release: () => release() };
  vi.spyOn(mongoose.Model, 'bulkWrite').mockImplementation(async function (this: typeof mongoose.Model, ...args: unknown[]) {
    if (!state.reached) {
      state.reached = true;
      if (mode === 'fail') throw new Error('injected rebuild write failure');
      await gate;
    }
    return (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
  } as never);
  return state;
}

const internals = syncService as unknown as {
  stopRequested: boolean;
  rebuildAddressIndexFromTransactions: () => Promise<void>;
};
const syncState = () => SyncState.findOne({ key: 'main' }).lean<Record<string, unknown>>();

describe.skipIf(!baseUri)('rebuilding the address index while it is being read, with disposable MongoDB', () => {
  const app = express();
  app.use('/api/richlist', richlistRoutes);

  beforeAll(async () => {
    if (!baseUri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/deftrack_pose_test_[a-f0-9]+$/.test(baseUri)) {
      throw new Error('TEST_POSE_MONGO_URI must name an isolated localhost test database');
    }
    // Own database, so it cannot collide with other integration suites that may run at the same time.
    await mongoose.connect(`${baseUri}ar`, { serverSelectionTimeoutMS: 5000 });
    await Promise.all([Block.init(), Transaction.init(), Address.init(), SyncState.init()]);
  });
  beforeEach(async () => {
    internals.stopRequested = false;
    vi.spyOn(realtimeService, 'publishNewBlock').mockImplementation(() => undefined);
    vi.spyOn(realtimeService, 'publishNewTx').mockImplementation(() => undefined);
    vi.spyOn(realtimeService, 'publishSyncStatus').mockImplementation(() => undefined);
    vi.spyOn(telegramService, 'notifyNewBlock').mockImplementation(() => undefined);
    await Promise.all([Block.deleteMany({}), Transaction.deleteMany({}), Address.deleteMany({}), SyncState.deleteMany({})]);
    if (await collectionExists(REBUILD_COLLECTION)) await mongoose.connection.db!.dropCollection(REBUILD_COLLECTION);
    await SyncState.create({ key: 'main', lastSyncedHeight: -1, lastSyncedHash: '', addressIndexVersion: 3, satoshiDataVersion: 3, addressStatsVersion: 1 });
    mockDaemon(2);
    await syncService.sync();
    invalidateRichlistCache();
  });
  afterAll(async () => {
    internals.stopRequested = false;
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('readers keep the complete previous address data while the rebuild runs', async () => {
    const before = await storedAddresses();
    const richlistBefore = (await request(app).get('/api/richlist')).body;
    expect(Object.keys(before)).toHaveLength(3);
    const writes = interceptRebuildWrites('hold');

    const rebuilding = internals.rebuildAddressIndexFromTransactions();
    try {
      await vi.waitFor(() => expect(writes.reached).toBe(true));
      // Mid-rebuild: the live collection is untouched, and the rich list answers from it.
      expect(await Address.countDocuments()).toBe(3);
      expect(await storedAddresses()).toEqual(before);
      invalidateRichlistCache();
      const richlistDuring = await request(app).get('/api/richlist');
      expect(richlistDuring.status).toBe(200);
      expect(richlistDuring.body.data).toEqual(richlistBefore.data);
    } finally {
      writes.release();
      await rebuilding;
    }

    expect(await storedAddresses()).toEqual(before);
    expect(await collectionExists(REBUILD_COLLECTION)).toBe(false);
  });

  it('a rebuild that fails leaves the previous address data as it was and no unfinished collection behind', async () => {
    const before = await storedAddresses();
    interceptRebuildWrites('fail');

    await expect(internals.rebuildAddressIndexFromTransactions()).rejects.toThrow('injected rebuild write failure');

    expect(await storedAddresses()).toEqual(before);
    expect(await collectionExists(REBUILD_COLLECTION)).toBe(false);
  });

  it('a requested rebuild that fails stays requested, and the next run completes it', async () => {
    const before = await storedAddresses();
    await SyncState.updateOne({ key: 'main' }, { addressRebuildRequired: true });
    interceptRebuildWrites('fail');

    await syncService.sync();
    expect(await syncState()).toMatchObject({ addressRebuildRequired: true, isRunning: false });
    expect(await storedAddresses()).toEqual(before);

    vi.mocked(mongoose.Model.bulkWrite).mockRestore();
    await syncService.sync();
    expect(await syncState()).toMatchObject({ addressRebuildRequired: false, error: null });
    expect(await storedAddresses()).toEqual(before);
  });

  it('a collection left by an interrupted earlier rebuild does not leak into the next one', async () => {
    const before = await storedAddresses();
    await mongoose.connection.db!.collection(REBUILD_COLLECTION).insertOne({ address: 'Dleftover', balanceSat: '5', txCount: 9 });

    await internals.rebuildAddressIndexFromTransactions();

    expect(await storedAddresses()).toEqual(before);
    expect(await collectionExists(REBUILD_COLLECTION)).toBe(false);
  });

  it('the swapped-in collection has the address indexes, including the unique address key', async () => {
    await internals.rebuildAddressIndexFromTransactions();

    const indexes = await Address.collection.indexes();
    const byKey = (key: Record<string, number>) => indexes.find((index) => JSON.stringify(index.key) === JSON.stringify(key));
    expect(byKey({ address: 1 })).toMatchObject({ unique: true });
    expect(byKey({ balanceSat: -1 })).toBeDefined();
    expect(byKey({ firstSeen: -1 })).toBeDefined();
    await expect(Address.collection.insertOne({ address: A })).rejects.toThrow(/E11000/);
  });
});
