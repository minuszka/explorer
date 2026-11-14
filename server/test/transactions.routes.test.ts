import express from 'express';
import request from 'supertest';
import transactionsRoutes from '../src/routes/transactions.routes';
import { Transaction } from '../src/models/Transaction';
import * as chainTipService from '../src/services/chainTip.service';

function mockFindOneQuery<T>(value: T | null) {
  return {
    lean: jest.fn().mockResolvedValue(value),
  };
}

describe('transactions routes', () => {
  const app = express();
  app.use('/api/txs', transactionsRoutes);
  app.use('/api/tx', transactionsRoutes);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GET /api/txs/latest returns 400 for invalid count', async () => {
    const res = await request(app).get('/api/txs/latest').query({ count: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'BAD_REQUEST' },
    });
  });

  it('GET /api/tx/:txid returns 400 for invalid txid format', async () => {
    const res = await request(app).get('/api/tx/not-a-txid');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'BAD_REQUEST' },
    });
  });

  it('GET /api/tx/:txid returns 404 when tx is missing', async () => {
    const txid = 'd'.repeat(64);
    jest.spyOn(Transaction, 'findOne').mockReturnValue(mockFindOneQuery(null) as never);
    jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({
      height: 200,
      time: 1_700_000_100,
      hash: 'tip',
    });

    const res = await request(app).get(`/api/tx/${txid}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('GET /api/tx/:txid returns tx with computed confirmations', async () => {
    const txid = 'e'.repeat(64);
    jest.spyOn(Transaction, 'findOne').mockReturnValue(
      mockFindOneQuery({
        txid,
        blockheight: 150,
        totalValueOutSat: 200_000_000,
        totalValueInSat: 250_000_000,
        feeSat: 50_000_000,
      }) as never
    );
    jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({
      height: 200,
      time: 1_700_000_100,
      hash: 'tip',
    });

    const res = await request(app).get(`/api/tx/${txid}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      txid,
      blockheight: 150,
      confirmations: 51,
    });
  });

  // Hashes are stored in lower case; a model that only knows the stored spelling stands in for Mongo.
  function mockStoredTx(txid: string, blockheight: number) {
    return jest.spyOn(Transaction, 'findOne').mockImplementation(((filter: { txid?: string }) =>
      mockFindOneQuery(filter.txid === txid
        ? { txid, blockheight, totalValueOutSat: 200_000_000, totalValueInSat: 250_000_000, feeSat: 50_000_000 }
        : null)) as never);
  }

  it('GET /api/tx/:txid finds a transaction whose id is typed in capitals', async () => {
    const txid = 'ab12'.repeat(16);
    const findOne = mockStoredTx(txid, 150);
    jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: 200, time: 1_700_000_100, hash: 'tip' });

    // Capitals first: nothing is cached yet, so the answer cannot come from an earlier lower-case request.
    const upper = await request(app).get(`/api/tx/${txid.toUpperCase()}`);
    const lower = await request(app).get(`/api/tx/${txid}`);

    expect(upper.status).toBe(200);
    expect(findOne).toHaveBeenCalledWith({ txid });
    expect(upper.body.data).toMatchObject({ txid, blockheight: 150, confirmations: 51 });
    expect(upper.body).toEqual(lower.body);
  });

  it('GET /api/tx/:txid counts confirmations from the current tip while the transaction is cached', async () => {
    const txid = 'c3d4'.repeat(16);
    const findOne = mockStoredTx(txid, 150);
    const tip = jest.spyOn(chainTipService, 'getChainTip');
    tip.mockResolvedValue({ height: 200, time: 1_700_000_100, hash: 'tip' });

    const first = await request(app).get(`/api/tx/${txid}`);
    tip.mockResolvedValue({ height: 203, time: 1_700_000_500, hash: 'tip3' });
    const second = await request(app).get(`/api/tx/${txid}`);
    tip.mockResolvedValue({ height: 200, time: 1_700_000_100, hash: 'tip' });
    const third = await request(app).get(`/api/tx/${txid}`);

    expect(first.body.data.confirmations).toBe(51);
    expect(second.body.data.confirmations).toBe(54);
    // The count follows the tip it is served with, also when that tip is lower again.
    expect(third.body.data.confirmations).toBe(51);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  describe('when the tip or the database cannot be read', () => {
    it('answers a cached transaction with the tip height it was cached at', async () => {
      const txid = 'f1a2'.repeat(16);
      const findOne = mockStoredTx(txid, 150);
      const tip = jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: 200, time: 1_700_000_100, hash: 'tip' });

      await request(app).get(`/api/tx/${txid}`);
      tip.mockRejectedValue(new Error('DB offline'));
      const res = await request(app).get(`/api/tx/${txid}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ txid, confirmations: 51 });
      expect(findOne).toHaveBeenCalledTimes(1);
    });

    it('answers from a stale cached transaction while both reads fail, but not forever', async () => {
      let now = 5_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      const txid = 'f3b4'.repeat(16);
      const findOne = mockStoredTx(txid, 150);
      const tip = jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: 200, time: 1_700_000_100, hash: 'tip' });

      await request(app).get(`/api/tx/${txid}`);
      // Past the fresh time (at most 20 s), within the stale limit (at least 120 s).
      now += 25_000;
      findOne.mockImplementation(() => { throw new Error('DB offline'); });
      tip.mockRejectedValue(new Error('DB offline'));
      const stale = await request(app).get(`/api/tx/${txid}`);
      now += 200_000;
      const expired = await request(app).get(`/api/tx/${txid}`);

      expect(stale.status).toBe(200);
      expect(stale.body.data).toMatchObject({ txid, confirmations: 51 });
      expect(expired.status).toBe(500);
    });

    it('reads a transaction once for requests that arrive while it is being read', async () => {
      const txid = 'f5c6'.repeat(16);
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const findOne = jest.spyOn(Transaction, 'findOne').mockImplementation((() => ({
        lean: jest.fn(async () => {
          await gate;
          return { txid, blockheight: 150, totalValueOutSat: 200_000_000, totalValueInSat: 250_000_000, feeSat: 50_000_000 };
        }),
      })) as never);
      jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: 200, time: 1_700_000_100, hash: 'tip' });

      const pending = Promise.all([0, 1, 2].map(() => request(app).get(`/api/tx/${txid}`).then((res) => res)));
      await vi.waitFor(() => expect(findOne).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      const answers = await pending;

      expect(answers.map((res) => [res.status, res.body.data?.confirmations])).toEqual([[200, 51], [200, 51], [200, 51]]);
      expect(findOne).toHaveBeenCalledTimes(1);
    });
  });
});
