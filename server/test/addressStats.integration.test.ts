import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const D = 'DKgo69ycaxuut3QxaTSfyqbkFvyRvvq8Hf';
const E = 'D9NofFTND226dT475V33QaHU9LKHK7UwVe';
const COIN = 100_000_000;

type RpcVin = { coinbase?: string; txid?: string; vout?: number; sequence: number; address?: string; value?: number; valueSat?: number };
type RpcVout = { value: number; valueSat: number; n: number; scriptPubKey: { asm: string; hex: string; type: string; addresses: string[] } };
type RpcTx = { txid: string; version: number; size: number; locktime: number; vin: RpcVin[]; vout: RpcVout[] };

const hashOf = (height: number) => height.toString(16).padStart(64, 'e');
const txidOf = (label: string) => label.padStart(64, '0');
const pay = (n: number, coins: number, address: string): RpcVout => ({
  value: coins, valueSat: Math.round(coins * COIN), n,
  scriptPubKey: { asm: '', hex: '76a914' + '00'.repeat(20) + '88ac', type: 'pubkeyhash', addresses: [address] },
});
const spend = (prev: string, n: number, coins: number, address: string): RpcVin => ({
  txid: txidOf(prev), vout: n, sequence: 0, address, value: coins, valueSat: Math.round(coins * COIN),
});
const coinbase = (label: string, coins: number, address: string): RpcTx => ({
  txid: txidOf(label), version: 3, size: 100, locktime: 0, vin: [{ coinbase: '03aa0d02', sequence: 0 }], vout: [pay(0, coins, address)],
});
const transfer = (label: string, vin: RpcVin[], vout: RpcVout[]): RpcTx => ({ txid: txidOf(label), version: 3, size: 225, locktime: 0, vin, vout });

// In block 2, A spends twice and D is paid twice: each takes part in two transactions of one block.
const TXS: RpcTx[][] = [
  [coinbase('c0', 1000, A)],
  [coinbase('c1', 1000, B)],
  [
    coinbase('c2', 50, C),
    transfer('x2', [spend('c0', 0, 1000, A)], [pay(0, 400, D), pay(1, 599.99, A)]),
    transfer('y2', [spend('x2', 1, 599.99, A)], [pay(0, 100, D), pay(1, 499.98, A)]),
  ],
  [
    coinbase('c3', 50, C),
    transfer('z3', [spend('x2', 0, 400, D)], [pay(0, 399.99, E)]),
  ],
];
const BLOCKS = TXS.map((tx, height) => ({
  hash: hashOf(height), confirmations: 1, size: 500, height, version: 1, merkleroot: 'm'.repeat(64), tx,
  time: 1_800_000_000 + height * 150, mediantime: 1_800_000_000 + height * 150, nonce: 0, bits: '1d00ffff',
  difficulty: 1, chainwork: '00', nTx: tx.length,
  ...(height > 0 ? { previousblockhash: hashOf(height - 1) } : {}),
}));

/** How many transactions each address takes part in, from the fixture alone. */
const EXPECTED_TX_COUNT = { [A]: 3, [B]: 1, [C]: 2, [D]: 3, [E]: 1 };

function mockDaemon(tip: number) {
  vi.spyOn(rpcService, 'getBlockCount').mockResolvedValue(tip);
  vi.spyOn(rpcService, 'getBlockHash').mockImplementation(async (height: number) => hashOf(height));
  vi.spyOn(rpcService, 'getBlock').mockImplementation(async (hash: string) => {
    const block = BLOCKS.find((candidate) => candidate.hash === hash);
    if (!block) throw new Error(`unknown block ${hash}`);
    return structuredClone(block);
  });
}

type StoredAddress = { address: string; balanceSat: unknown; totalReceivedSat: unknown; totalSentSat: unknown; txCount: number; firstSeen: number; lastSeen: number };
async function storedAddresses(fields: Array<keyof StoredAddress>) {
  const docs = await Address.find({}).lean<StoredAddress[]>();
  return Object.fromEntries(docs.sort((a, b) => a.address.localeCompare(b.address)).map((doc) =>
    [doc.address, Object.fromEntries(fields.map((field) => [field, String(doc[field])]))]));
}
const ALL_FIELDS: Array<keyof StoredAddress> = ['balanceSat', 'totalReceivedSat', 'totalSentSat', 'txCount', 'firstSeen', 'lastSeen'];

const internals = syncService as unknown as {
  stopRequested: boolean;
  ADDRESS_STATS_VERSION: number;
  rebuildAddressIndexFromTransactions: () => Promise<void>;
};
const syncState = () => SyncState.findOne({ key: 'main' }).lean<Record<string, unknown>>();
const freshState = (extra: Record<string, unknown> = {}) =>
  SyncState.create({ key: 'main', lastSyncedHeight: -1, lastSyncedHash: '', addressIndexVersion: 3, satoshiDataVersion: 3, ...extra });

describe.skipIf(!baseUri)('address statistics from live sync and from a rebuild, with disposable MongoDB', () => {
  beforeAll(async () => {
    if (!baseUri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/deftrack_pose_test_[a-f0-9]+$/.test(baseUri)) {
      throw new Error('TEST_POSE_MONGO_URI must name an isolated localhost test database');
    }
    // Own database, so it cannot collide with other integration suites that may run at the same time.
    await mongoose.connect(`${baseUri}as`, { serverSelectionTimeoutMS: 5000 });
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
    await syncService.stop();
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('live sync and a rebuild give the same balances (as before this change)', async () => {
    mockDaemon(3);
    await freshState();
    await syncService.sync();
    const live = await storedAddresses(['balanceSat', 'totalReceivedSat', 'totalSentSat']);

    await internals.rebuildAddressIndexFromTransactions();

    expect(await storedAddresses(['balanceSat', 'totalReceivedSat', 'totalSentSat'])).toEqual(live);
  });

  it('live sync and a rebuild give the same value in every address field, counting each transaction once', async () => {
    mockDaemon(3);
    await freshState();
    await syncService.sync();
    const live = await storedAddresses(ALL_FIELDS);

    await internals.rebuildAddressIndexFromTransactions();

    expect(await storedAddresses(ALL_FIELDS)).toEqual(live);
    const counts = Object.fromEntries(Object.entries(live).map(([address, fields]) => [address, Number(fields.txCount)]));
    expect(counts).toEqual(EXPECTED_TX_COUNT);
  });

  it('an older address statistics version rebuilds the address index once at start, and only once', async () => {
    mockDaemon(3);
    await freshState();
    await syncService.sync();
    // Counts as an older release left them: one per block instead of one per transaction.
    await Address.updateMany({}, { $set: { txCount: 1 } });
    await SyncState.updateOne({ key: 'main' }, { $unset: { addressStatsVersion: 1 } });
    const rebuild = vi.spyOn(internals, 'rebuildAddressIndexFromTransactions');

    try {
      await syncService.start();
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(await syncState()).toMatchObject({ addressStatsVersion: internals.ADDRESS_STATS_VERSION });
      const counts = Object.fromEntries(Object.entries(await storedAddresses(['txCount'])).map(([address, fields]) => [address, Number(fields.txCount)]));
      expect(counts).toEqual(EXPECTED_TX_COUNT);

      // The next start finds the current version and does not rebuild again.
      await syncService.stop();
      await syncService.start();
      expect(rebuild).toHaveBeenCalledTimes(1);
    } finally {
      await syncService.stop();
    }
  });

  it('an empty database starts at the current version without a rebuild', async () => {
    mockDaemon(0);
    // An index version change on an empty database resets the state (ensureIndexVersion).
    await freshState({ addressIndexVersion: 0 });
    const rebuild = vi.spyOn(internals, 'rebuildAddressIndexFromTransactions');

    try {
      await syncService.start();
      expect(rebuild).not.toHaveBeenCalled();
      expect(await syncState()).toMatchObject({ addressStatsVersion: internals.ADDRESS_STATS_VERSION, lastSyncedHeight: 0 });
    } finally {
      await syncService.stop();
    }
  });

  it('a start that already rebuilds for another reason settles the version with that one rebuild', async () => {
    mockDaemon(3);
    await freshState();
    await syncService.sync();
    // A lock left behind by a killed process: startup recovery rebuilds anyway.
    await SyncState.updateOne({ key: 'main' }, { $set: { isRunning: true }, $unset: { addressStatsVersion: 1 } });
    const rebuild = vi.spyOn(internals, 'rebuildAddressIndexFromTransactions');

    try {
      await syncService.start();
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(await syncState()).toMatchObject({ addressStatsVersion: internals.ADDRESS_STATS_VERSION, isRunning: false });
    } finally {
      await syncService.stop();
    }
  });
});
