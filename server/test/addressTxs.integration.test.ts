import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import addressRoutes from '../src/routes/addresses.routes';
import transactionsRoutes from '../src/routes/transactions.routes';
import { Address } from '../src/models/Address';
import { Transaction } from '../src/models/Transaction';
import * as chainTipService from '../src/services/chainTip.service';

// This suite requires an explicitly supplied disposable localhost database.
// The normal unit suite must never connect to an operator's configured MongoDB.
const baseUri = process.env.TEST_POSE_MONGO_URI;

const STAKER = 'DNSSwp3CWfyus5h8TSBvJHFoTUASQCF8Rj';
const MINER = 'D8e1nUDayNHvXSYZPv1QECNcSgCxgsXw9d';
const OTHER = 'D11111111111111111111111111111111';
const dec = (sat: string) => mongoose.Types.Decimal128.fromString(sat);
const out = (sat: string, address?: string, type = address ? 'pubkeyhash' : 'nonstandard') => ({
  valueSat: dec(sat),
  scriptPubKey: { type, ...(address ? { addresses: [address] } : {}) },
});

// Shaped like the chain's transactions: a stake spends one output back to the same address
// with an empty first output, a block reward has a coinbase input, a transfer pays a fee.
const TXS = [
  {
    txid: 'a'.repeat(64),
    blockheight: 300,
    isCoinbase: false,
    vin: [{ txid: 'f'.repeat(64), vout: 1, address: STAKER, valueSat: dec('2537500000000') }],
    vout: [out('0'), out('2587500000000', STAKER, 'pubkey')],
    totalValueInSat: dec('2537500000000'),
    totalValueOutSat: dec('2587500000000'),
    feeSat: dec('0'),
    involvedAddresses: [STAKER],
  },
  {
    txid: 'b'.repeat(64),
    blockheight: 299,
    isCoinbase: true,
    vin: [{ coinbase: '03aa0d02' }],
    vout: [out('0'), out('1000000000000', STAKER)],
    totalValueInSat: dec('0'),
    totalValueOutSat: dec('1000000000000'),
    feeSat: dec('0'),
    involvedAddresses: [STAKER],
  },
  {
    txid: 'c'.repeat(64),
    blockheight: 298,
    isCoinbase: false,
    vin: [{ txid: 'e'.repeat(64), vout: 0, address: STAKER, valueSat: dec('50000000000') }],
    vout: [out('10000000000', OTHER), out('39999990000', STAKER)],
    totalValueInSat: dec('50000000000'),
    totalValueOutSat: dec('49999990000'),
    feeSat: dec('10000'),
    involvedAddresses: [STAKER, OTHER],
  },
];

describe.skipIf(!baseUri)('address transaction list with disposable MongoDB', () => {
  const app = express();
  app.use('/api/address', addressRoutes);
  app.use('/api/tx', transactionsRoutes);

  beforeAll(async () => {
    if (!baseUri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/deftrack_pose_test_[a-f0-9]+$/.test(baseUri)) {
      throw new Error('TEST_POSE_MONGO_URI must name an isolated localhost test database');
    }
    // Own database, so it cannot collide with the PoSe suites that may run at the same time.
    await mongoose.connect(`${baseUri}ad`, { serverSelectionTimeoutMS: 5000 });
    await Promise.all([Transaction.init(), Address.init()]);
  });
  beforeEach(async () => {
    vi.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: 310, time: 1_800_000_000, hash: 'tip' });
    await Promise.all([Transaction.deleteMany({}), Address.deleteMany({})]);
    await Transaction.insertMany(TXS.map((tx) => ({ ...tx, blockhash: tx.txid.replace(/./g, '9'), blocktime: 1_800_000_000 - (310 - tx.blockheight) * 60 })));
    await Address.create({ address: STAKER, txCount: TXS.length });
  });
  afterAll(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('gives each listed transaction the same input total, fee, reward flag and output types as the transaction page', async () => {
    const list = await request(app).get(`/api/address/${STAKER}/txs`).query({ limit: 10 });
    expect(list.status).toBe(200);
    expect(list.body.data.map((tx: { txid: string }) => tx.txid)).toEqual(TXS.map((tx) => tx.txid));
    const outputTypes = (tx: { vout: Array<{ scriptPubKey?: { type?: string } }> }) =>
      tx.vout.map((output) => output.scriptPubKey?.type);

    for (const listed of list.body.data) {
      const detail = await request(app).get(`/api/tx/${listed.txid}`);
      expect(detail.status).toBe(200);
      for (const field of ['isCoinbase', 'totalValueInSat', 'totalValueIn', 'totalValueOut', 'feeSat', 'fee']) {
        expect({ txid: listed.txid, field, value: listed[field] })
          .toEqual({ txid: listed.txid, field, value: detail.body.data[field] });
      }
      expect({ txid: listed.txid, types: outputTypes(listed) })
        .toEqual({ txid: listed.txid, types: outputTypes(detail.body.data) });
    }

    const [stake, reward, transfer] = list.body.data;
    // The empty first output of a stake or reward is "nonstandard" on both pages, not unknown.
    expect(outputTypes(stake)).toEqual(['nonstandard', 'pubkey']);
    expect(outputTypes(reward)).toEqual(['nonstandard', 'pubkeyhash']);
    expect(stake).toMatchObject({ isCoinbase: false, totalValueIn: 25375, totalValueOut: 25875, fee: 0 });
    expect(reward).toMatchObject({ isCoinbase: true, totalValueIn: 0, totalValueOut: 10000 });
    expect(transfer).toMatchObject({ isCoinbase: false, totalValueIn: 500, feeSat: '10000', fee: 0.0001 });
  });
});
