import express from 'express';
import request from 'supertest';
import searchRoutes from '../src/routes/search.routes';
import addressRoutes from '../src/routes/v1/address.v1.routes';
import { Block } from '../src/models/Block';
import { Address } from '../src/models/Address';
import { Transaction } from '../src/models/Transaction';

const app = express();
app.use('/search', searchRoutes);
app.use('/address', addressRoutes);
function query(value: unknown) {
  // A lean query is awaited for its rows, or read one row at a time through a cursor.
  const rows = Array.isArray(value) ? value : [];
  const lean = Object.assign(Promise.resolve(value), {
    cursor: () => (async function* () { yield* rows; })(),
  });
  return { select: vi.fn().mockReturnThis(), sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(), lean: vi.fn().mockReturnValue(lean) };
}

describe('stale response fallback', () => {
  it.each([true, false])('preserves a cached search result (found=%s) only until the stale deadline', async (found) => {
    let now = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const height = found ? 813 : 814;
    const find = vi.spyOn(Block, 'findOne').mockReturnValue(query(found ? { height, hash: 'a'.repeat(64) } : null) as never);
    const url = `/search?q=${height}`;
    const first = await request(app).get(url);
    expect(first.status).toBe(found ? 200 : 404);
    now += 16000;
    find.mockImplementation(() => { throw new Error('DB offline'); });
    const stale = await request(app).get(url);
    expect(stale.status).toBe(first.status);
    expect(stale.body).toEqual(first.body);
    now += 60000;
    expect((await request(app).get(url)).status).toBe(500);
  });

  it.each(['graph', 'rewards'])('preserves address %s after refresh failure but never indefinitely', async (kind) => {
    let now = 2000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(Transaction, 'findOne').mockReturnValue(query(null) as never);
    const find = vi.spyOn(Transaction, 'find').mockReturnValue(query([]) as never);
    vi.spyOn(Address, 'find').mockReturnValue(query([]) as never);
    const aggregate = vi.spyOn(Transaction, 'aggregate').mockResolvedValue([]);
    const url = `/address/D11111111111111111111111111/${kind}`;
    const first = await request(app).get(url);
    expect(first.status).toBe(200);
    now += 21000;
    find.mockImplementation(() => { throw new Error('DB offline'); });
    aggregate.mockRejectedValue(new Error('DB offline'));
    const stale = await request(app).get(url);
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual(first.body);
    now += 90000;
    expect((await request(app).get(url)).status).toBe(500);
  });
});
