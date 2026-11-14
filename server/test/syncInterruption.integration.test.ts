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
type RpcBlock = { hash: string; height: number; time: number; tx: RpcTx[]; previousblockhash?: string; nextblockhash?: string } & Record<string, unknown>;

const hashOf = (height: number) => height.toString(16).padStart(64, 'b');
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

// A small chain shaped like the daemon's verbose blocks. Block 2 has a coinbase and two transfers.
const TXS: RpcTx[][] = [
  [coinbase('c0', 1000, A)],
  [coinbase('c1', 1000, B)],
  [
    coinbase('c2', 50, C),
    transfer('x2', [spend('c0', 0, 1000, A)], [pay(0, 400, D), pay(1, 599.99, A)]),
    transfer('y2', [spend('c1', 0, 1000, B)], [pay(0, 100, D), pay(1, 899.99, B)]),
  ],
  [
    coinbase('c3', 50, C),
    transfer('z3', [spend('x2', 0, 400, D)], [pay(0, 399.99, E)]),
  ],
];
const BLOCKS: RpcBlock[] = TXS.map((tx, height) => ({
  hash: hashOf(height), confirmations: 1, size: 500, height, version: 1, merkleroot: 'm'.repeat(64), tx,
  time: 1_800_000_000 + height * 150, mediantime: 1_800_000_000 + height * 150, nonce: 0, bits: '1d00ffff',
  difficulty: 1, chainwork: '00', nTx: tx.length,
  ...(height > 0 ? { previousblockhash: hashOf(height - 1) } : {}),
  ...(height < TXS.length - 1 ? { nextblockhash: hashOf(height + 1) } : {}),
}));
const BLOCK2 = BLOCKS[2];

/** What every address should hold after the blocks up to `height`, from the fixture alone. */
function expectedBalances(height: number) {
  const totals = new Map<string, { received: bigint; sent: bigint }>();
  const entry = (address: string) => {
    const found = totals.get(address) ?? { received: 0n, sent: 0n };
    totals.set(address, found);
    return found;
  };
  for (const block of BLOCKS.slice(0, height + 1)) {
    for (const tx of block.tx) {
      for (const output of tx.vout) for (const address of output.scriptPubKey.addresses) entry(address).received += BigInt(output.valueSat);
      for (const input of tx.vin) if (input.address) entry(input.address).sent += BigInt(input.valueSat ?? 0);
    }
  }
  return Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b)).map(([address, { received, sent }]) =>
    [address, { balance: String(received - sent), received: String(received), sent: String(sent) }]));
}

async function storedBalances() {
  const docs = await Address.find({}).lean<Array<{ address: string; balanceSat: unknown; totalReceivedSat: unknown; totalSentSat: unknown }>>();
  return Object.fromEntries(docs.sort((a, b) => a.address.localeCompare(b.address)).map((doc) =>
    [doc.address, { balance: String(doc.balanceSat), received: String(doc.totalReceivedSat), sent: String(doc.totalSentSat) }]));
}

const syncState = () => SyncState.findOne({ key: 'main' }).lean<Record<string, unknown>>();

/** The daemon, answering from the fixture up to `tip`. `hold` keeps a block's answer back until released. */
function mockDaemon(tip: number) {
  vi.spyOn(rpcService, 'getBlockCount').mockResolvedValue(tip);
  vi.spyOn(rpcService, 'getBlockHash').mockImplementation(async (height: number) => hashOf(height));
  return vi.spyOn(rpcService, 'getBlock').mockImplementation(async (hash: string) => {
    const block = BLOCKS.find((candidate) => candidate.hash === hash);
    if (!block) throw new Error(`unknown block ${hash}`);
    return structuredClone(block);
  });
}

type AnyMethods = Record<string, (...args: unknown[]) => unknown>;

/** Makes the first call of `method` that `matches` its arguments throw; every other call goes through. */
function failOnce(model: object, method: string, matches: (...args: unknown[]) => boolean) {
  const target = model as AnyMethods;
  const original = target[method].bind(model);
  const state = { failed: false };
  vi.spyOn(target, method).mockImplementation((...args: unknown[]) => {
    if (!state.failed && matches(...args)) {
      state.failed = true;
      throw new Error(`injected failure in ${method}`);
    }
    return original(...args);
  });
  return state;
}

/** Holds the first call of `method` that `matches` until `release()`; every other call goes through. */
function holdOnce(model: object, method: string, matches: (...args: unknown[]) => boolean) {
  const target = model as AnyMethods;
  const original = target[method].bind(model);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const state = { reached: false, release: () => release() };
  vi.spyOn(target, method).mockImplementation((...args: unknown[]) => {
    if (!state.reached && matches(...args)) {
      state.reached = true;
      // A thenable query stand-in: the real query runs once the gate opens.
      const run = gate.then(() => original(...args) as Promise<unknown>);
      const chain = { select: () => chain, lean: () => chain, then: run.then.bind(run), catch: run.catch.bind(run) };
      return chain;
    }
    return original(...args);
  });
  return state;
}

const internals = syncService as unknown as { stopRequested: boolean; stopTimeoutMs: number };

describe.skipIf(!baseUri)('indexing a block that is interrupted, with disposable MongoDB', () => {
  beforeAll(async () => {
    if (!baseUri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/deftrack_pose_test_[a-f0-9]+$/.test(baseUri)) {
      throw new Error('TEST_POSE_MONGO_URI must name an isolated localhost test database');
    }
    // Own database, so it cannot collide with other integration suites that may run at the same time.
    await mongoose.connect(`${baseUri}si`, { serverSelectionTimeoutMS: 5000 });
    await Promise.all([Block.init(), Transaction.init(), Address.init(), SyncState.init()]);
  });
  beforeEach(async () => {
    internals.stopRequested = false;
    vi.spyOn(realtimeService, 'publishNewBlock').mockImplementation(() => undefined);
    vi.spyOn(realtimeService, 'publishNewTx').mockImplementation(() => undefined);
    vi.spyOn(realtimeService, 'publishSyncStatus').mockImplementation(() => undefined);
    vi.spyOn(telegramService, 'notifyNewBlock').mockImplementation(() => undefined);
    await Promise.all([Block.deleteMany({}), Transaction.deleteMany({}), Address.deleteMany({}), SyncState.deleteMany({})]);
    await SyncState.create({ key: 'main', lastSyncedHeight: -1, lastSyncedHash: '', addressIndexVersion: 3, satoshiDataVersion: 3 });
  });
  afterAll(async () => {
    internals.stopRequested = false;
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('the fixture chain indexes to the expected balances without failures', async () => {
    mockDaemon(3);
    await syncService.sync();

    expect(await storedBalances()).toEqual(expectedBalances(3));
    expect(await syncState()).toMatchObject({ lastSyncedHeight: 3, isRunning: false, addressRebuildRequired: false, error: null });
  });

  it('T1: a transaction write that fails halfway through a block loses no balance change', async () => {
    mockDaemon(3);
    const failure = failOnce(Transaction, 'findOneAndUpdate', (filter) => (filter as { txid?: string })?.txid === txidOf('x2'));

    await syncService.sync();
    expect(failure.failed).toBe(true);
    expect(await syncState()).toMatchObject({ isRunning: false, error: 'injected failure in findOneAndUpdate' });

    await syncService.sync();
    expect(await storedBalances()).toEqual(expectedBalances(3));
    expect(await syncState()).toMatchObject({ lastSyncedHeight: 3, addressRebuildRequired: false, error: null });
  });

  it('T2: a failed balance write counts nothing twice', async () => {
    mockDaemon(3);
    const failure = failOnce(Address, 'bulkWrite', (ops) =>
      Array.isArray(ops) && ops.some((op) => (op as { updateOne?: { filter?: { address?: string } } }).updateOne?.filter?.address === D));

    await syncService.sync();
    expect(failure.failed).toBe(true);
    await syncService.sync();

    expect(await storedBalances()).toEqual(expectedBalances(3));
  });

  it('T3: a failed block write counts nothing twice', async () => {
    mockDaemon(3);
    const failure = failOnce(Block, 'findOneAndUpdate', (filter, update) =>
      (filter as { hash?: string })?.hash === BLOCK2.hash && (update as { height?: number })?.height === 2);

    await syncService.sync();
    expect(failure.failed).toBe(true);
    expect(await Block.findOne({ height: 2 }).lean()).toBeNull();
    await syncService.sync();

    expect(await storedBalances()).toEqual(expectedBalances(3));
  });

  it('T4: stop() waits for the block being indexed, then stops before the next one', async () => {
    mockDaemon(3);
    const held = holdOnce(Transaction, 'findOneAndUpdate', (filter) => (filter as { txid?: string })?.txid === txidOf('y2'));

    const running = syncService.sync();
    let stopped = false;
    try {
      await vi.waitFor(() => expect(held.reached).toBe(true));
      const stopping = syncService.stop().then(() => { stopped = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Still waiting: block 2 is half written.
      expect(stopped).toBe(false);
      held.release();
      await stopping;
    } finally {
      held.release();
      await running;
    }

    expect(await Block.findOne({ height: 2 }).lean()).not.toBeNull();
    expect(await Block.findOne({ height: 3 }).lean()).toBeNull();
    expect(await syncState()).toMatchObject({
      isRunning: false, addressRebuildRequired: false, lastSyncedHeight: 2, lastSyncedHash: BLOCK2.hash,
    });
    expect(await storedBalances()).toEqual(expectedBalances(2));
    // A stopped service does not start another run: it neither asks the daemon nor writes the state.
    const daemonCalls = vi.mocked(rpcService.getBlockCount).mock.calls.length;
    const stateBefore = await syncState();
    await syncService.sync();
    expect(vi.mocked(rpcService.getBlockCount).mock.calls.length).toBe(daemonCalls);
    expect(await syncState()).toEqual(stateBefore);
    expect(await Block.findOne({ height: 3 }).lean()).toBeNull();
  });

  it('T5: when the block does not finish in time, stop() leaves the lock for startup recovery', async () => {
    mockDaemon(3);
    const held = holdOnce(Transaction, 'findOneAndUpdate', (filter) => (filter as { txid?: string })?.txid === txidOf('y2'));
    const timeoutBefore = internals.stopTimeoutMs;
    internals.stopTimeoutMs = 200;

    const running = syncService.sync();
    await vi.waitFor(() => expect(held.reached).toBe(true));
    try {
      await syncService.stop();
      expect(await syncState()).toMatchObject({ isRunning: true, addressRebuildRequired: true });
    } finally {
      internals.stopTimeoutMs = timeoutBefore;
      held.release();
      await running;
    }
  });

  it('a block does not clear a rebuild that was already requested before it started', async () => {
    mockDaemon(0);
    await SyncState.updateOne({ key: 'main' }, { addressRebuildRequired: true });

    await (syncService as unknown as { processBlock: (height: number) => Promise<unknown> }).processBlock(0);

    expect(await Block.findOne({ height: 0 }).lean()).not.toBeNull();
    expect(await syncState()).toMatchObject({ addressRebuildRequired: true });
  });

  it('T6: when the in-progress mark cannot be written, the block is not started', async () => {
    mockDaemon(1);
    await syncService.sync();
    expect(await syncState()).toMatchObject({ lastSyncedHeight: 1, addressRebuildRequired: false });

    mockDaemon(3);
    const failure = failOnce(SyncState, 'findOneAndUpdate', (_filter, update) => {
      const fields = update as { addressRebuildRequired?: boolean; $set?: { addressRebuildRequired?: boolean } };
      return fields?.addressRebuildRequired === true || fields?.$set?.addressRebuildRequired === true;
    });
    await syncService.sync();

    expect(failure.failed).toBe(true);
    expect(await Transaction.countDocuments({ blockheight: 2 })).toBe(0);
    expect(await syncState()).toMatchObject({ isRunning: false, error: 'injected failure in findOneAndUpdate' });

    await syncService.sync();
    expect(await storedBalances()).toEqual(expectedBalances(3));
  });
});
