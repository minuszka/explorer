import express from 'express';
import request from 'supertest';
import blocksRoutes from '../src/routes/blocks.routes';
import { Block } from '../src/models/Block';
import { Transaction } from '../src/models/Transaction';
import * as chainTipService from '../src/services/chainTip.service';

function mockBlockListQuery<T>(value: T[]) {
  return {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

function mockFindOneQuery<T>(value: T | null) {
  return {
    lean: jest.fn().mockResolvedValue(value),
  };
}

describe('blocks routes', () => {
  const app = express();
  app.use('/api/blocks', blocksRoutes);
  app.use('/api/block', blocksRoutes);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GET /api/blocks returns 400 for invalid pagination', async () => {
    const res = await request(app).get('/api/blocks').query({ page: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'BAD_REQUEST' },
    });
  });

  it('GET /api/blocks swaps from/to range and returns confirmations', async () => {
    const block = {
      hash: 'c'.repeat(64),
      height: 150,
      time: 1_700_000_000,
      rewardSat: 1_000_000_000,
      totalValueOutSat: 2_000_000_000,
    };

    jest.spyOn(Block, 'find').mockReturnValue(mockBlockListQuery([block]) as never);
    jest.spyOn(Block, 'countDocuments').mockResolvedValue(1);
    jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({
      height: 200,
      time: 1_700_000_100,
      hash: 'tip',
    });

    const res = await request(app).get('/api/blocks').query({
      page: 1,
      limit: 1,
      from: 200,
      to: 100,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.filters).toEqual({ from: 100, to: 200 });
    expect(res.body.pagination).toMatchObject({
      page: 1,
      limit: 1,
      total: 1,
      pages: 1,
    });
    expect(res.body.data[0]).toMatchObject({
      height: 150,
      confirmations: 51,
    });
  });

  describe('block producer and masternode payee', () => {
    const STAKER = 'DKgo69ycaxuut3QxaTSfyqbkFvyRvvq8Hf';
    const PAYEE = 'DGK3yNxxedc2pvaPPwTbVBey2NmFC8FUGZ';
    const marker = { valueSat: '0', scriptPubKey: { addresses: [], hex: '' } };
    const coinbase = {
      txid: 'cb', isCoinbase: true, vin: [{}],
      vout: [marker, { valueSat: '1000000000000', scriptPubKey: { addresses: [PAYEE] } }],
    };
    const coinstake = {
      txid: 'cs', isCoinbase: false, vin: [{ address: STAKER }],
      vout: [marker, { valueSat: '1151045000000', scriptPubKey: { addresses: [STAKER] } }],
    };
    const block = (height: number) => ({
      hash: 'd'.repeat(64), height, time: 1_700_000_000, rewardSat: 1_050_000_000_000,
      totalValueOutSat: 2_151_045_000_000, txids: ['cb', 'cs'], minedBy: PAYEE,
    });
    const mockRoleTxs = (txs: unknown[]) => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(txs) });

    beforeEach(() => {
      jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: 169_480, time: 1_700_000_600, hash: 'tip' });
    });

    it('names the coinstake address as the staker and keeps minedBy as stored', async () => {
      jest.spyOn(Block, 'findOne').mockReturnValue(mockFindOneQuery(block(169_470)) as never);
      const find = jest.spyOn(Transaction, 'find').mockReturnValue(mockRoleTxs([coinstake, coinbase]) as never);

      const res = await request(app).get('/api/block/169470');

      expect(res.status).toBe(200);
      expect(find).toHaveBeenCalledWith({ txid: { $in: ['cb', 'cs'] } });
      expect(res.body.data).toMatchObject({
        height: 169_470,
        minedBy: PAYEE,
        producer: { address: STAKER, kind: 'staker' },
        masternodePayee: PAYEE,
      });
    });

    it('answers null for both when the coinstake is not indexed', async () => {
      jest.spyOn(Block, 'findOne').mockReturnValue(mockFindOneQuery(block(169_471)) as never);
      jest.spyOn(Transaction, 'find').mockReturnValue(mockRoleTxs([coinbase]) as never);

      const res = await request(app).get('/api/block/169471');

      expect(res.status).toBe(200);
      expect(res.body.data.producer).toBeNull();
      expect(res.body.data.masternodePayee).toBeNull();
    });
  });

  describe('a block hash typed in capitals', () => {
    const hash = 'ab34'.repeat(16);
    const stored = { hash, height: 150, time: 1_700_000_000, rewardSat: 1_000_000_000, totalValueOutSat: 2_000_000_000, txids: [], nTx: 1 };
    const tx = { txid: 'e5f6'.repeat(16), blockheight: 150, totalValueOutSat: 200_000_000, feeSat: 0 };
    const mockTxList = (rows: unknown[]) => ({
      sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(rows),
    });
    // Hashes are stored in lower case; these models only know the stored spelling, like Mongo.
    const mockStoredBlock = () => jest.spyOn(Block, 'findOne').mockImplementation(((filter: { hash?: string }) => {
      const query = { select: jest.fn(), lean: jest.fn().mockResolvedValue(filter.hash === hash ? stored : null) };
      query.select.mockReturnValue(query);
      return query;
    }) as never);

    beforeEach(() => {
      jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: 200, time: 1_700_000_100, hash: 'tip' });
    });

    it('GET /api/block/:hash finds the block', async () => {
      const findOne = mockStoredBlock();

      // Capitals first: nothing is cached yet, so the answer cannot come from an earlier lower-case request.
      const upper = await request(app).get(`/api/block/${hash.toUpperCase()}`);
      const lower = await request(app).get(`/api/block/${hash}`);

      expect(upper.status).toBe(200);
      expect(findOne).toHaveBeenCalledWith({ hash });
      expect(upper.body.data).toMatchObject({ hash, height: 150, confirmations: 51 });
      expect(upper.body).toEqual(lower.body);
    });

    it('GET /api/block/:hash/txs lists its transactions', async () => {
      const findOne = mockStoredBlock();
      const find = jest.spyOn(Transaction, 'find').mockImplementation(((filter: { blockhash?: string }) =>
        mockTxList(filter.blockhash === hash ? [tx] : [])) as never);

      const upper = await request(app).get(`/api/block/${hash.toUpperCase()}/txs`);
      const lower = await request(app).get(`/api/block/${hash}/txs`);

      expect(upper.status).toBe(200);
      expect(find).toHaveBeenCalledWith({ blockhash: hash });
      expect(findOne).toHaveBeenCalledWith({ hash });
      expect(upper.body.data).toHaveLength(1);
      expect(upper.body.data[0]).toMatchObject({ txid: tx.txid });
      expect(upper.body.pagination).toMatchObject({ total: 1 });
      expect(upper.body).toEqual(lower.body);
    });
  });

  describe('a block that stays cached while the chain grows', () => {
    const cachedBlock = (height: number, extra: Record<string, unknown> = {}) => ({
      hash: 'f'.repeat(64), height, time: 1_700_000_000, rewardSat: 1_000_000_000, totalValueOutSat: 2_000_000_000, txids: [], ...extra,
    });

    it('counts confirmations from the current tip without reading the block again', async () => {
      const findOne = jest.spyOn(Block, 'findOne')
        .mockReturnValue(mockFindOneQuery(cachedBlock(180_000, { nextblockhash: '1'.repeat(64) })) as never);
      const tip = jest.spyOn(chainTipService, 'getChainTip');
      tip.mockResolvedValue({ height: 180_010, time: 1_700_000_100, hash: 'tip' });

      const first = await request(app).get('/api/block/180000');
      tip.mockResolvedValue({ height: 180_013, time: 1_700_000_500, hash: 'tip3' });
      const second = await request(app).get('/api/block/180000');
      tip.mockResolvedValue({ height: 180_010, time: 1_700_000_100, hash: 'tip' });
      const third = await request(app).get('/api/block/180000');

      expect(first.body.data.confirmations).toBe(11);
      expect(second.body.data.confirmations).toBe(14);
      // The count follows the tip it is served with, also when that tip is lower again.
      expect(third.body.data.confirmations).toBe(11);
      expect(findOne).toHaveBeenCalledTimes(1);
    });

    it('reads the tip block again once a block follows it, so the link to the next block appears', async () => {
      const next = '2'.repeat(64);
      const findOne = jest.spyOn(Block, 'findOne');
      findOne.mockReturnValue(mockFindOneQuery(cachedBlock(181_000)) as never);
      const tip = jest.spyOn(chainTipService, 'getChainTip');
      tip.mockResolvedValue({ height: 181_000, time: 1_700_000_100, hash: 'tip' });

      const atTip = await request(app).get('/api/block/181000');
      const stillAtTip = await request(app).get('/api/block/181000');
      expect(atTip.body.data).toMatchObject({ height: 181_000, confirmations: 1 });
      expect(atTip.body.data.nextblockhash).toBeUndefined();
      // While the block is the tip, the cached copy is good.
      expect(stillAtTip.body).toEqual(atTip.body);
      expect(findOne).toHaveBeenCalledTimes(1);

      findOne.mockReturnValue(mockFindOneQuery(cachedBlock(181_000, { nextblockhash: next })) as never);
      tip.mockResolvedValue({ height: 181_001, time: 1_700_000_250, hash: next });
      const afterNext = await request(app).get('/api/block/181000');

      expect(afterNext.body.data).toMatchObject({ height: 181_000, confirmations: 2, nextblockhash: next });
      expect(findOne).toHaveBeenCalledTimes(2);
    });

    it('answers a cached block with the tip height it was cached at when the tip cannot be read', async () => {
      const findOne = jest.spyOn(Block, 'findOne')
        .mockReturnValue(mockFindOneQuery(cachedBlock(183_000, { nextblockhash: '3'.repeat(64) })) as never);
      const tip = jest.spyOn(chainTipService, 'getChainTip');
      tip.mockResolvedValue({ height: 183_010, time: 1_700_000_100, hash: 'tip' });

      await request(app).get('/api/block/183000');
      tip.mockRejectedValue(new Error('DB offline'));
      const res = await request(app).get('/api/block/183000');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ height: 183_000, confirmations: 11 });
      expect(findOne).toHaveBeenCalledTimes(1);
    });

    it('answers from a stale cached block while both reads fail, but not forever', async () => {
      let now = 7_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      const findOne = jest.spyOn(Block, 'findOne')
        .mockReturnValue(mockFindOneQuery(cachedBlock(184_000, { nextblockhash: '4'.repeat(64) })) as never);
      const tip = jest.spyOn(chainTipService, 'getChainTip');
      tip.mockResolvedValue({ height: 184_010, time: 1_700_000_100, hash: 'tip' });

      await request(app).get('/api/block/184000');
      // Past the fresh time (at most 15 s), within the stale limit (at least 90 s).
      now += 20_000;
      findOne.mockImplementation(() => { throw new Error('DB offline'); });
      tip.mockRejectedValue(new Error('DB offline'));
      const stale = await request(app).get('/api/block/184000');
      now += 200_000;
      const expired = await request(app).get('/api/block/184000');

      expect(stale.status).toBe(200);
      expect(stale.body.data).toMatchObject({ height: 184_000, confirmations: 11 });
      expect(expired.status).toBe(500);
    });

    it('reads a block once for requests that arrive while it is being read', async () => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const findOne = jest.spyOn(Block, 'findOne').mockImplementation((() => ({
        lean: jest.fn(async () => {
          await gate;
          return cachedBlock(185_000, { nextblockhash: '5'.repeat(64) });
        }),
      })) as never);
      jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: 185_010, time: 1_700_000_100, hash: 'tip' });

      const pending = Promise.all([0, 1, 2].map(() => request(app).get('/api/block/185000').then((res) => res)));
      await vi.waitFor(() => expect(findOne).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      const answers = await pending;

      expect(answers.map((res) => [res.status, res.body.data?.confirmations])).toEqual([[200, 11], [200, 11], [200, 11]]);
      expect(findOne).toHaveBeenCalledTimes(1);
    });

    it('does not read a block again on every request when its link is missing for another reason', async () => {
      // Read when the chain was already past it, so the tip moving is no news for this copy.
      const findOne = jest.spyOn(Block, 'findOne').mockReturnValue(mockFindOneQuery(cachedBlock(182_000)) as never);
      jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: 182_005, time: 1_700_000_100, hash: 'tip' });

      const first = await request(app).get('/api/block/182000');
      const second = await request(app).get('/api/block/182000');

      expect(first.body.data.confirmations).toBe(6);
      expect(second.body).toEqual(first.body);
      expect(findOne).toHaveBeenCalledTimes(1);
    });
  });

  it('GET /api/block/:hashOrHeight returns 404 when block does not exist', async () => {
    jest.spyOn(Block, 'findOne').mockReturnValue(mockFindOneQuery(null) as never);
    jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({
      height: 200,
      time: 1_700_000_100,
      hash: 'tip',
    });

    const res = await request(app).get('/api/block/999999');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});
