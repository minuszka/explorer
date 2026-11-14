import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import dashboardRoutes, { invalidateDashboardCache } from '../src/routes/dashboard.routes';
import blocksRoutes from '../src/routes/blocks.routes';
import * as statsService from '../src/services/stats.service';
import * as chainTipService from '../src/services/chainTip.service';
import { rpcService } from '../src/services/rpc.service';
import { Block } from '../src/models/Block';
import { Transaction } from '../src/models/Transaction';

// This suite requires an explicitly supplied disposable localhost database.
// The normal unit suite must never connect to an operator's configured MongoDB.
const baseUri = process.env.TEST_POSE_MONGO_URI;

const STAKER = 'DNSSwp3CWfyus5h8TSBvJHFoTUASQCF8Rj';
const PAYEE = 'DGK3yNxxedc2pvaPPwTbVBey2NmFC8FUGZ';
const SENDER = 'D8e1nUDayNHvXSYZPv1QECNcSgCxgsXw9d';
const RECEIVER = 'DKgo69ycaxuut3QxaTSfyqbkFvyRvvq8Hf';
const TIP = 1_000;
const BLOCK_COUNT = 14;
const dec = (sat: bigint) => mongoose.Types.Decimal128.fromString(sat.toString());
const COIN = 100_000_000n;

// Shaped like the chain stores them. A proof-of-stake coinbase and a coinstake open with an empty
// marker output: worth nothing, paying no address, with an empty script.
const marker = () => ({ valueSat: dec(0n), scriptPubKey: { type: 'nonstandard', hex: '' } });
const pay = (coins: bigint, address: string) => ({
  valueSat: dec(coins * COIN), scriptPubKey: { type: 'pubkeyhash', hex: '76a914' + '00'.repeat(20) + '88ac', addresses: [address] },
});
const id = (label: string, height: number) => `${label}${height}`.padStart(64, '0');

// Every block: a coinbase paying the masternode and a coinstake of STAKER. Every second block also
// carries a transfer from SENDER to RECEIVER.
function chain() {
  const blocks: Array<Record<string, unknown>> = [];
  const txs: Array<Record<string, unknown>> = [];
  for (let n = 0; n < BLOCK_COUNT; n++) {
    const height = TIP - n;
    const time = 1_800_000_000 + height * 150;
    const common = { blockhash: height.toString(16).padStart(64, 'a'), blockheight: height, blocktime: time };
    const coinbase = { ...common, txid: id('cb', height), isCoinbase: true, vin: [{ coinbase: '03aa0d02' }], vout: [marker(), pay(10_000n, PAYEE)] };
    const stake = {
      ...common, txid: id('cs', height), isCoinbase: false,
      vin: [{ txid: id('p', height), vout: 1, address: STAKER, valueSat: dec(25_000n * COIN) }],
      vout: [marker(), pay(25_500n, STAKER)],
    };
    const blockTxs = [coinbase, stake];
    if (n % 2 === 0) {
      blockTxs.push({
        ...common, txid: id('tr', height), isCoinbase: false,
        vin: [{ txid: id('q', height), vout: 0, address: SENDER, valueSat: dec(100n * COIN) }],
        vout: [pay(40n, RECEIVER), pay(59n, SENDER)],
      });
    }
    txs.push(...blockTxs);
    blocks.push({
      hash: common.blockhash, height, time, nTx: blockTxs.length, size: 500, difficulty: 1,
      version: 1, merkleroot: 'm'.repeat(64), nonce: 0, bits: '1d00ffff',
      // What the indexer stores as minedBy: the first address the coinbase pays, here the masternode.
      minedBy: PAYEE, rewardSat: dec(10_500n * COIN), totalValueOutSat: dec(35_599n * COIN),
      txids: blockTxs.map((tx) => tx.txid),
    });
  }
  return { blocks, txs };
}

describe.skipIf(!baseUri)('home page lists and block lists with disposable MongoDB', () => {
  const app = express();
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/blocks', blocksRoutes);

  beforeAll(async () => {
    if (!baseUri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/deftrack_pose_test_[a-f0-9]+$/.test(baseUri)) {
      throw new Error('TEST_POSE_MONGO_URI must name an isolated localhost test database');
    }
    // Own database, so it cannot collide with other integration suites that may run at the same time.
    await mongoose.connect(`${baseUri}dl`, { serverSelectionTimeoutMS: 5000 });
    await Promise.all([Block.init(), Transaction.init()]);
    const { blocks, txs } = chain();
    await Promise.all([Block.deleteMany({}), Transaction.deleteMany({})]);
    await Promise.all([Block.insertMany(blocks), Transaction.insertMany(txs)]);
  });
  beforeEach(() => {
    invalidateDashboardCache();
    vi.spyOn(statsService, 'getStatsData').mockResolvedValue({} as never);
    vi.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: TIP, time: 1_800_000_000 + TIP * 150, hash: 'tip' });
    vi.spyOn(rpcService, 'getBlockCount').mockResolvedValue(TIP);
  });
  afterAll(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('the home page overview names each block\'s staker, not the masternode it paid', async () => {
    const res = await request(app).get('/api/dashboard/overview');

    expect(res.status).toBe(200);
    const blocks = res.body.data.blocks as Array<{ height: number; producer: unknown; minedBy: string; txids?: unknown }>;
    expect(blocks).toHaveLength(10);
    for (const block of blocks) {
      expect(block.producer).toEqual({ address: STAKER, kind: 'staker' });
      expect(block.minedBy).toBe(PAYEE);
      expect(block.txids).toBeUndefined();
    }
  });

  it('the latest transactions and the blocks are equally many, and carry what tells a stake from a transfer', async () => {
    const res = await request(app).get('/api/dashboard/overview');

    const txs = res.body.data.txs as Array<{ vin: Array<{ address?: string }>; vout: Array<{ scriptPubKey?: { type?: string } }> }>;
    expect(txs).toHaveLength(res.body.data.blocks.length);
    const stake = txs.find((tx) => tx.vin.some((input) => input.address === STAKER));
    expect(stake?.vout.map((output) => output.scriptPubKey?.type)).toEqual(['nonstandard', 'pubkeyhash']);
  });

  it('the transfers list leaves out block rewards and stakes', async () => {
    const res = await request(app).get('/api/dashboard/overview');

    const transfers = res.body.data.transfers as Array<{ txid: string; isCoinbase: boolean; blockheight: number }>;
    // Seven of the fourteen blocks carry a transfer.
    expect(transfers.map((tx) => tx.txid)).toEqual(
      Array.from({ length: 7 }, (_, n) => id('tr', TIP - 2 * n))
    );
    expect(transfers.every((tx) => !tx.isCoinbase)).toBe(true);
  });

  it('the block list names each block\'s staker, on every way of paging', async () => {
    for (const path of ['/api/blocks?cursor=1&limit=5', '/api/blocks?page=2&limit=5', '/api/blocks/latest?count=5']) {
      const res = await request(app).get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect(res.body.data).toHaveLength(5);
      for (const block of res.body.data as Array<{ producer: unknown; txids?: unknown }>) {
        expect({ path, producer: block.producer, txids: block.txids }).toEqual({ path, producer: { address: STAKER, kind: 'staker' }, txids: undefined });
      }
    }
  });
});
