import express from 'express';
import request from 'supertest';
import searchRoutes from '../src/routes/search.routes';
import { Block } from '../src/models/Block';
import { Transaction } from '../src/models/Transaction';
import { Address } from '../src/models/Address';

function mockSelectedFindOne<T>(value: T | null) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

describe('search routes', () => {
  const app = express();
  app.use('/api/search', searchRoutes);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GET /api/search returns 400 for missing query', async () => {
    const res = await request(app).get('/api/search');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'BAD_REQUEST' },
    });
  });

  it('GET /api/search returns block match for numeric height', async () => {
    const blockDoc = { height: 123, hash: 'a'.repeat(64) };
    jest.spyOn(Block, 'findOne').mockReturnValue(mockSelectedFindOne(blockDoc) as never);
    const txSpy = jest.spyOn(Transaction, 'findOne');

    const res = await request(app).get('/api/search').query({ q: '123' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        type: 'block',
        result: blockDoc,
      },
    });
    expect(txSpy).not.toHaveBeenCalled();
  });

  it('GET /api/search falls back to tx lookup when block hash is not found', async () => {
    const hex = 'b'.repeat(64);
    jest.spyOn(Block, 'findOne').mockReturnValueOnce(mockSelectedFindOne(null) as never);
    jest
      .spyOn(Transaction, 'findOne')
      .mockReturnValueOnce(mockSelectedFindOne({ txid: hex }) as never);

    const res = await request(app).get('/api/search').query({ q: hex });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        type: 'transaction',
        result: { txid: hex },
      },
    });
  });

  it('GET /api/search finds a hash typed in capitals and answers the lower-case query from the same cache entry', async () => {
    const hex = 'cd56'.repeat(16);
    // Hashes are stored in lower case; these models only know the stored spelling, like Mongo.
    const blockSpy = jest.spyOn(Block, 'findOne').mockImplementation((() => mockSelectedFindOne(null)) as never);
    const txSpy = jest.spyOn(Transaction, 'findOne').mockImplementation(((filter: { txid?: string }) =>
      mockSelectedFindOne(filter.txid === hex ? { txid: hex } : null)) as never);

    // Capitals first: nothing is cached yet, so the answer cannot come from an earlier lower-case request.
    const upper = await request(app).get('/api/search').query({ q: hex.toUpperCase() });
    const lower = await request(app).get('/api/search').query({ q: hex });

    expect(upper.status).toBe(200);
    expect(upper.body).toMatchObject({ success: true, data: { type: 'transaction', result: { txid: hex } } });
    expect(blockSpy).toHaveBeenCalledWith({ hash: hex });
    expect(txSpy).toHaveBeenCalledWith({ txid: hex });
    expect(upper.body).toEqual(lower.body);
    expect(txSpy).toHaveBeenCalledTimes(1);
  });

  it('GET /api/search keeps the letter case of an address', async () => {
    const address = 'DAbCdEfGhJkLmNpQrStUvWxYz123456789';
    const addressSpy = jest.spyOn(Address, 'findOne').mockReturnValue(mockSelectedFindOne({ address }) as never);

    const res = await request(app).get('/api/search').query({ q: address });

    expect(res.status).toBe(200);
    expect(addressSpy).toHaveBeenCalledWith({ address });
    expect(res.body).toMatchObject({ success: true, data: { type: 'address', result: { address } } });
  });

  it('GET /api/search returns 404 when address format is valid but not found', async () => {
    const address = 'D11111111111111111111111111';
    jest.spyOn(Address, 'findOne').mockReturnValue(mockSelectedFindOne(null) as never);

    const res = await request(app).get('/api/search').query({ q: address });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
      },
    });
  });
});
