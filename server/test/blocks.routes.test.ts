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
