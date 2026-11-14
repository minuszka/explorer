import {
  buildAddressDeltaPipeline,
  canApplyAddressDeltas,
  collectAddressDeltas,
  collectInvolvedAddresses,
  mergeAddressDeltas,
  normalizeSat,
  type AddressDelta,
} from '../src/services/sync/addressIndexing';

describe('address indexing domain', () => {
  it('validates whether transaction address deltas are safe to apply', () => {
    expect(canApplyAddressDeltas([{ txid: 'a' }], true)).toBe(true);
    expect(canApplyAddressDeltas([{ txid: 'a' }], false)).toBe(false);
    expect(
      canApplyAddressDeltas([{ txid: 'a', address: 'Daddr', valueSat: '1' }], false)
    ).toBe(true);
  });

  it('normalizes satoshi and coin values deterministically', () => {
    expect(normalizeSat('250')).toBe(250n);
    expect(normalizeSat('', 1.5)).toBe(150000000n);
    expect(normalizeSat(undefined, null)).toBe(0n);
  });

  it('collects unique involved addresses and signed balance deltas', () => {
    const vins = [{ txid: 'prev', address: 'Dsender', valueSat: '7' }];
    const vouts = [
      { valueSat: '4', scriptPubKey: { addresses: ['Dreceiver', 'Dsender'] } },
      { valueSat: '3', scriptPubKey: { addresses: ['Dreceiver'] } },
    ];

    expect(collectInvolvedAddresses(vins, vouts)).toEqual(['Dsender', 'Dreceiver']);
    expect(collectAddressDeltas(vins, vouts, false)).toEqual(
      new Map([
        ['Dreceiver', { receivedSat: 7n, sentSat: 0n, txCount: 1 }],
        ['Dsender', { receivedSat: 4n, sentSat: 7n, txCount: 1 }],
      ])
    );
  });

  it('merges per-transaction deltas for block-level bulk writes', () => {
    const target = new Map([['Daddr', { receivedSat: 2n, sentSat: 1n, txCount: 1 }]]);
    mergeAddressDeltas(
      target,
      new Map([
        ['Daddr', { receivedSat: 3n, sentSat: 4n, txCount: 1 }],
        ['Dnew', { receivedSat: 5n, sentSat: 0n, txCount: 1 }],
      ])
    );

    expect(target).toEqual(
      new Map([
        ['Daddr', { receivedSat: 5n, sentSat: 5n, txCount: 2 }],
        ['Dnew', { receivedSat: 5n, sentSat: 0n, txCount: 1 }],
      ])
    );
  });

  it('counts an address once for each transaction of a block it takes part in', () => {
    const block = new Map<string, AddressDelta>();
    const pay = (address: string, valueSat: string) => ({ valueSat, scriptPubKey: { addresses: [address] } });
    // Two transactions of one block, both spending from and paying back to Dself.
    mergeAddressDeltas(block, collectAddressDeltas([{ txid: 'p1', address: 'Dself', valueSat: '10' }], [pay('Dother', '4'), pay('Dself', '6')], false));
    mergeAddressDeltas(block, collectAddressDeltas([{ txid: 'p2', address: 'Dself', valueSat: '6' }], [pay('Dother', '1'), pay('Dself', '5')], false));

    expect(block.get('Dself')).toEqual({ receivedSat: 11n, sentSat: 16n, txCount: 2 });
    expect(block.get('Dother')).toEqual({ receivedSat: 5n, sentSat: 0n, txCount: 2 });
  });

  it('builds the atomic MongoDB update pipeline used by live sync and rebuilds', () => {
    const pipeline = buildAddressDeltaPipeline(
      'Dabc',
      { receivedSat: 11n, sentSat: 3n, txCount: 2 },
      1700000000
    );
    const setStage = (pipeline[0] as { $set?: Record<string, unknown> }).$set;

    expect(pipeline).toHaveLength(1);
    expect(setStage).toBeDefined();
    expect((setStage?.address as { $ifNull: [string, string] }).$ifNull[1]).toBe('Dabc');
    // The block's transactions with this address, not one per block.
    expect((setStage?.txCount as { $add: [number, number] }).$add[1]).toBe(2);
  });
});
