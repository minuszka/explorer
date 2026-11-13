import { Block } from '../src/models/Block';
import { Transaction } from '../src/models/Transaction';
import { countStakersSince } from '../src/services/blockRoles.service';

const marker = { valueSat: '0', scriptPubKey: { addresses: [], hex: '' } };
const coinstake = (txid: string, staker: string) => ({
  txid, isCoinbase: false, vin: [{ address: staker }],
  vout: [marker, { valueSat: '1151045000000', scriptPubKey: { addresses: [staker] } }],
});
const query = <T>(value: T) => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(value) });

describe('countStakersSince', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts the different addresses that staked, not the masternodes the coinbase paid', async () => {
    const blockFind = jest.spyOn(Block, 'find').mockReturnValue(query([
      { txids: ['cb1', 'cs1'] }, { txids: ['cb2', 'cs2'] }, { txids: ['cb3', 'cs3'] }, { txids: ['cb4'] },
    ]) as never);
    const txFind = jest.spyOn(Transaction, 'find').mockReturnValue(query([
      coinstake('cs1', 'DStakerA'), coinstake('cs2', 'DStakerB'), coinstake('cs3', 'DStakerA'),
    ]) as never);

    await expect(countStakersSince(1_700_000_000)).resolves.toBe(2);
    expect(blockFind).toHaveBeenCalledWith({ time: { $gte: 1_700_000_000 } });
    expect(txFind).toHaveBeenCalledWith({ txid: { $in: ['cs1', 'cs2', 'cs3'] } });
  });

  it('is unknown, not zero, when no block in the window has a readable coinstake', async () => {
    jest.spyOn(Block, 'find').mockReturnValue(query([{ txids: ['cb1', 'tx1'] }]) as never);
    jest.spyOn(Transaction, 'find').mockReturnValue(query([
      { txid: 'tx1', isCoinbase: false, vin: [{ address: 'DA' }, { address: 'DB' }], vout: [marker] },
    ]) as never);

    await expect(countStakersSince(1_700_000_000)).resolves.toBeUndefined();
  });

  it('does not query transactions when no block is in the window', async () => {
    jest.spyOn(Block, 'find').mockReturnValue(query([]) as never);
    const txFind = jest.spyOn(Transaction, 'find');

    await expect(countStakersSince(1_700_000_000)).resolves.toBeUndefined();
    expect(txFind).not.toHaveBeenCalled();
  });
});
