import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import addressV1Routes from '../src/routes/v1/address.v1.routes';
import { Transaction } from '../src/models/Transaction';

// This suite requires an explicitly supplied disposable localhost database.
// The normal unit suite must never connect to an operator's configured MongoDB.
const baseUri = process.env.TEST_POSE_MONGO_URI;

const STAKER = 'DNSSwp3CWfyus5h8TSBvJHFoTUASQCF8Rj';
const OTHER_STAKER = 'D8e1nUDayNHvXSYZPv1QECNcSgCxgsXw9d';
const PAYEE = 'DGK3yNxxedc2pvaPPwTbVBey2NmFC8FUGZ';
const DFCN = 100_000_000n;
const dec = (sat: bigint) => mongoose.Types.Decimal128.fromString(sat.toString());
const sat = (coins: number) => BigInt(coins) * DFCN;

// Shaped like the chain stores them. A coinstake and a proof-of-stake coinbase open with an empty
// marker output: worth nothing, paying no address, with an empty script.
const marker = () => ({ valueSat: dec(0n), scriptPubKey: { type: 'nonstandard', hex: '' } });
const pay = (amount: bigint, address: string) => ({
  valueSat: dec(amount),
  scriptPubKey: { type: 'pubkeyhash', hex: '76a914' + '00'.repeat(20) + '88ac', addresses: [address] },
});
const spend = (amount: bigint, address: string, n: number) => ({ txid: n.toString(16).padStart(64, '0'), vout: 1, address, valueSat: dec(amount) });

let nextId = 1;
function tx(fields: { blocktime: number; isCoinbase?: boolean; vin: unknown[]; vout: unknown[]; feeSat?: bigint }) {
  const id = (nextId++).toString(16).padStart(64, 'a');
  return {
    txid: id,
    blockhash: id.replace(/a/g, '9'),
    blockheight: 1000 + nextId,
    blocktime: fields.blocktime,
    isCoinbase: fields.isCoinbase ?? false,
    vin: fields.vin,
    vout: fields.vout,
    feeSat: dec(fields.feeSat ?? 0n),
  };
}

const T0 = 1_800_000_000;
const TXS = [
  // A stake of 25 375 DFCN that came back as 25 875: a 500 DFCN reward.
  tx({ blocktime: T0, vin: [spend(sat(25_375), STAKER, 1)], vout: [marker(), pay(sat(25_875), STAKER)] }),
  // A later stake of two coins, returned in two outputs: again 500 DFCN net.
  tx({
    blocktime: T0 + 600,
    vin: [spend(sat(1_000), STAKER, 2), spend(sat(2_000), STAKER, 3)],
    vout: [marker(), pay(sat(1_750), STAKER), pay(sat(1_750), STAKER)],
  }),
  // Not stakes, though they pay no fee: a transfer whose first output pays someone, and a payment
  // back to itself that opens with a zero-value note (it has a script, so it is no marker).
  tx({ blocktime: T0 + 900, vin: [spend(sat(300), STAKER, 4)], vout: [pay(sat(100), PAYEE), pay(sat(200), STAKER)] }),
  tx({
    blocktime: T0 + 1_200,
    vin: [spend(sat(400), STAKER, 5)],
    vout: [{ valueSat: dec(0n), scriptPubKey: { type: 'nulldata', hex: '6a04deadbeef' } }, pay(sat(400), STAKER)],
  }),
  // Another address's stake, which also pays STAKER nothing.
  tx({ blocktime: T0 + 1_500, vin: [spend(sat(9_000), OTHER_STAKER, 6)], vout: [marker(), pay(sat(9_500), OTHER_STAKER)] }),
  // A masternode payment to STAKER in a proof-of-stake coinbase.
  tx({ blocktime: T0 + 1_800, isCoinbase: true, vin: [{ coinbase: '03aa0d02' }], vout: [marker(), pay(sat(10_000), STAKER)] }),
];

describe.skipIf(!baseUri)('address rewards with disposable MongoDB', () => {
  const app = express();
  app.use('/api/v1/address', addressV1Routes);

  beforeAll(async () => {
    if (!baseUri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/deftrack_pose_test_[a-f0-9]+$/.test(baseUri)) {
      throw new Error('TEST_POSE_MONGO_URI must name an isolated localhost test database');
    }
    // Own database, so it cannot collide with other integration suites that may run at the same time.
    await mongoose.connect(`${baseUri}rw`, { serverSelectionTimeoutMS: 5000 });
    await Transaction.init();
  });
  beforeEach(async () => {
    await Transaction.deleteMany({});
    await Transaction.insertMany(TXS);
  });
  afterAll(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('counts the stakes the address made and their net reward, and keeps the masternode payments as they were', async () => {
    const res = await request(app).get(`/api/v1/address/${STAKER}/rewards`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      address: STAKER,
      coinbaseTxCount: 1,
      coinbaseTotal: 10_000,
      lastCoinbaseAt: T0 + 1_800,
      stakeTxCount: 2,
      stakeTotal: 1_000,
      lastStakeAt: T0 + 600,
    });
  });

  it('gives another staker only its own stake', async () => {
    const res = await request(app).get(`/api/v1/address/${OTHER_STAKER}/rewards`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stakeTxCount: 1, stakeTotal: 500, lastStakeAt: T0 + 1_500, coinbaseTxCount: 0 });
  });

  it('answers zero, not an error, for an address that never staked', async () => {
    const res = await request(app).get(`/api/v1/address/${PAYEE}/rewards`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stakeTxCount: 0, stakeTotal: 0, lastStakeAt: null, coinbaseTxCount: 0, coinbaseTotal: 0 });
  });
});
