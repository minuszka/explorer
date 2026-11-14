import express from 'express';
import request from 'supertest';
import aiRoutes from '../src/routes/ai.routes';
import { Block } from '../src/models/Block';
import { Transaction } from '../src/models/Transaction';
import * as chainTipService from '../src/services/chainTip.service';

function mockSelectedFindOne<T>(value: T | null) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

describe('AI lookup route', () => {
  const app = express();
  app.use('/api/ai', aiRoutes);

  beforeEach(() => {
    jest.spyOn(chainTipService, 'getChainTip').mockResolvedValue({ height: 200, time: 1_700_000_100, hash: 'tip' });
  });

  // Hashes are stored in lower case; these models only know the stored spelling, like Mongo.
  it('finds a transaction whose id is typed in capitals', async () => {
    const txid = 'ab78'.repeat(16);
    const tx = { txid, blockhash: '9'.repeat(64), blockheight: 150, blocktime: 1_700_000_000, isCoinbase: false, vin: [], vout: [] };
    jest.spyOn(Block, 'findOne').mockImplementation((() => mockSelectedFindOne(null)) as never);
    const txSpy = jest.spyOn(Transaction, 'findOne').mockImplementation(((filter: { txid?: string }) =>
      mockSelectedFindOne(filter.txid === txid ? tx : null)) as never);

    const upper = await request(app).get('/api/ai/lookup').query({ q: txid.toUpperCase() });
    const lower = await request(app).get('/api/ai/lookup').query({ q: txid });

    expect(upper.status).toBe(200);
    expect(txSpy).toHaveBeenCalledWith({ txid });
    expect(upper.body).toMatchObject({ success: true, type: 'transaction', data: { txid, blockHeight: 150, confirmations: 51 } });
    expect(upper.body).toEqual(lower.body);
  });

  it('finds a block whose hash is typed in capitals', async () => {
    const hash = 'cd90'.repeat(16);
    const block = { hash, height: 150, time: 1_700_000_000, nTx: 2, size: 500 };
    jest.spyOn(Transaction, 'findOne').mockImplementation((() => mockSelectedFindOne(null)) as never);
    const blockSpy = jest.spyOn(Block, 'findOne').mockImplementation(((filter: { hash?: string }) =>
      mockSelectedFindOne(filter.hash === hash ? block : null)) as never);

    const upper = await request(app).get('/api/ai/lookup').query({ q: hash.toUpperCase() });
    const lower = await request(app).get('/api/ai/lookup').query({ q: hash });

    expect(upper.status).toBe(200);
    expect(blockSpy).toHaveBeenCalledWith({ hash });
    expect(upper.body).toMatchObject({ success: true, type: 'block', data: { hash, height: 150, txCount: 2 } });
    expect(upper.body).toEqual(lower.body);
  });
});
