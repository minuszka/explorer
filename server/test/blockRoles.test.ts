import { blockRoles, stakerOf, type RoleTx } from '../src/utils/blockRoles';

// The shapes come from the live chain (2026-11-13, public API): block 169470's coinbase pays
// 10,000 DFCN to the masternode after an empty marker; its coinstake spends DKgo…'s 11,010.45
// and pays 11,510.45 back to DKgo…. Blocks 1 and 100 were mined: one coinbase, paying the miner.
const STAKER = 'DKgo69ycaxuut3QxaTSfyqbkFvyRvvq8Hf';
const PAYEE = 'DGK3yNxxedc2pvaPPwTbVBey2NmFC8FUGZ';
const OTHER = `D${'R'.repeat(33)}`;
const MINER = `Z${'H'.repeat(33)}`;

const marker = { valueSat: '0', scriptPubKey: { addresses: [] as string[], hex: '' } };
const pay = (valueSat: string, address: string) => ({ valueSat, scriptPubKey: { addresses: [address] } });

function coinbase(txid: string, vout: RoleTx['vout']): RoleTx {
  return { txid, isCoinbase: true, vin: [{}], vout };
}

function coinstake(txid: string, inputs: string[], vout: RoleTx['vout']): RoleTx {
  return { txid, isCoinbase: false, vin: inputs.map((address) => ({ address })), vout };
}

const posCoinbase = coinbase('cb', [marker, pay('1000000000000', PAYEE)]);
const posCoinstake = coinstake('cs', [STAKER], [marker, pay('1151045000000', STAKER)]);

describe('block roles', () => {
  it('names the coinstake address as the staker and the coinbase payee as the masternode', () => {
    expect(blockRoles(['cb', 'cs'], [posCoinstake, posCoinbase])).toEqual({
      producer: { address: STAKER, kind: 'staker' },
      masternodePayee: PAYEE,
    });
  });

  it('accepts a stake split over several outputs and several inputs of the same address', () => {
    const split = coinstake('cs', [STAKER, STAKER], [marker, pay('550025000000000', STAKER), pay('550025000000000', STAKER)]);
    expect(stakerOf(split)).toBe(STAKER);
  });

  it('reads amounts stored as Decimal128-like objects', () => {
    const decimal = (text: string) => ({ toString: () => text });
    const tx = coinstake('cs', [STAKER], [
      { valueSat: decimal('0'), scriptPubKey: { addresses: [], hex: '' } },
      { valueSat: decimal('1151045000000'), scriptPubKey: { addresses: [STAKER] } },
    ]);
    expect(stakerOf(tx)).toBe(STAKER);
  });

  it('does not name a staker when the inputs come from different addresses', () => {
    const mixed = coinstake('cs', [STAKER, OTHER], [marker, pay('1151045000000', STAKER)]);
    expect(blockRoles(['cb', 'cs'], [posCoinbase, mixed])).toEqual({ producer: null, masternodePayee: null });
  });

  it('does not name a staker when the stake does not come back to the spender', () => {
    const transfer = coinstake('cs', [STAKER], [marker, pay('1151045000000', OTHER)]);
    expect(stakerOf(transfer)).toBeNull();
  });

  it('does not treat a missing or unreadable amount as the empty marker', () => {
    const missing = coinstake('cs', [STAKER], [{ scriptPubKey: { addresses: [], hex: '' } }, pay('1151045000000', STAKER)]);
    const unreadable = coinstake('cs', [STAKER], [{ valueSat: 'abc', scriptPubKey: { addresses: [], hex: '' } }, pay('1151045000000', STAKER)]);
    const dust = coinstake('cs', [STAKER], [{ valueSat: '1', scriptPubKey: { addresses: [], hex: '' } }, pay('1151045000000', STAKER)]);
    expect([stakerOf(missing), stakerOf(unreadable), stakerOf(dust)]).toEqual([null, null, null]);
  });

  it('does not take a zero-value OP_RETURN note, or an output stored without its script, for the marker', () => {
    // A transfer that starts with a note and sends its change back to the spender is not a coinstake.
    const note = coinstake('tx', [STAKER], [{ valueSat: '0', scriptPubKey: { addresses: [], hex: '6a0b68656c6c6f20776f726c64' } }, pay('1151045000000', STAKER)]);
    const noScript = coinstake('cs', [STAKER], [{ valueSat: '0', scriptPubKey: { addresses: [] } }, pay('1151045000000', STAKER)]);
    expect([stakerOf(note), stakerOf(noScript)]).toEqual([null, null]);
    expect(blockRoles(['cb', 'tx'], [posCoinbase, note])).toEqual({ producer: null, masternodePayee: null });
  });

  it('leaves the masternode payee unknown when the coinbase pays several addresses', () => {
    const superblock = coinbase('cb', [marker, pay('1000000000000', PAYEE), pay('500000000000', OTHER)]);
    expect(blockRoles(['cb', 'cs'], [superblock, posCoinstake])).toEqual({
      producer: { address: STAKER, kind: 'staker' },
      masternodePayee: null,
    });
  });

  it('has no masternode payee when the coinbase pays nobody (early proof-of-stake blocks)', () => {
    expect(blockRoles(['cb', 'cs'], [coinbase('cb', [marker]), posCoinstake])).toEqual({
      producer: { address: STAKER, kind: 'staker' },
      masternodePayee: null,
    });
  });

  it('names the miner of a mined block, whose coinbase pays the reward straight to one address', () => {
    const mined = coinbase('cb', [pay('1100000000000000', MINER)]);
    expect(blockRoles(['cb'], [mined])).toEqual({ producer: { address: MINER, kind: 'miner' }, masternodePayee: null });
    const transfer = coinstake('tx', [OTHER], [pay('100000000', MINER), pay('50000000', OTHER)]);
    expect(blockRoles(['cb', 'tx'], [mined, transfer]).producer).toEqual({ address: MINER, kind: 'miner' });
  });

  it('is unknown when a transaction it needs is not indexed', () => {
    expect(blockRoles(['cb', 'cs'], [posCoinbase])).toEqual({ producer: null, masternodePayee: null });
    expect(blockRoles(['cb', 'cs'], [posCoinstake])).toEqual({ producer: null, masternodePayee: null });
    expect(blockRoles([], [])).toEqual({ producer: null, masternodePayee: null });
    expect(blockRoles(undefined, [])).toEqual({ producer: null, masternodePayee: null });
  });

  it('does not call a proof-of-stake coinbase a miner when the coinstake is unrecognised', () => {
    const odd = coinstake('cs', [STAKER, OTHER], [marker, pay('1151045000000', STAKER)]);
    expect(blockRoles(['cb', 'cs'], [posCoinbase, odd]).producer).toBeNull();
  });
});
