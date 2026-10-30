import { assessDsl, diagnoseOperator, inventoryForOperator, parseOperatorRegistry, type DslFinality, type OperatorInventory, type OperatorNode, type ReviveHistory } from '../src/domain/pose/operatorDiagnosis';
import { operatorDslSchema, type OperatorDsl } from '@defcon/shared/dist/contracts';
const id = 'a'.repeat(64), now = new Date('2026-10-07T12:00:00Z');
const node = (penalty = 75, ban = -1, dsl = -1) => parseOperatorRegistry([{ proTxHash: id,
  state: { service: '198.51.100.1:8192', PoSePenalty: penalty, PoSeBanHeight: ban, dslBanHeight: dsl } }])[0];
const inventory = (extra = {}): OperatorInventory => ({ ip: '198.51.100.1', port: 8192, masternodeProTxHash: id,
  walletVersion: '22.1.4', lastVersionObservedAt: now, lastObservedAt: now, chainStatus: 'behind', ...extra });
const history = (): ReviveHistory[] => [100, 110, 120, 130].map((h, i) => ({ proTxHash: id, poseBanHeight: h,
  detectedAt: new Date(now.getTime() - 10000 + i * 2000), recoveredHeight: h + 8,
  recoveredAt: new Date(now.getTime() - 9000 + i * 2000) }));
describe('operator diagnoses', () => {
  it('uses the full dynamic registry cap and includes the exact 75-point boundary', () => {
    expect(diagnoseOperator(node(74), 220, now, [])).toEqual([]);
    const result = diagnoseOperator(node(), 220, now, []);
    expect(result[0]).toMatchObject({ code: 'BAN_NEXT_DKG', evidence: 'chain', level: 'action', operatorAction: true, since: now.toISOString() });
    expect(result[0].hint).toContain('1 score-decreasing block');
    expect(diagnoseOperator(node(145), 220, now, [])[0].hint).toContain('71 score-decreasing');
    expect(diagnoseOperator(node(34), 90, now, [])[0].message).toContain('34/100');
    expect(diagnoseOperator(node(75), 400, now, [])).toEqual([]);
  });
  it('never flags PoSe-banned or DSL-banned nodes even above the current maximum', () => {
    expect(diagnoseOperator(node(309, 148000), 220, now, [])).toEqual([]);
    expect(diagnoseOperator(node(220, -1, 148000), 220, now, [])).toEqual([]);
  });
  it('requires complete validated registered state and rejects duplicate or empty registries', () => {
    expect(() => parseOperatorRegistry([])).toThrow();
    expect(() => parseOperatorRegistry([node(), node()])).toThrow();
    const n = node(); delete (n.state as Partial<typeof n.state>).dslBanHeight;
    expect(() => parseOperatorRegistry([n])).toThrow();
  });
  it('requires three distinct height-bound revive/reban pairs and preserves pattern evidence', () => {
    const h = history();
    expect(diagnoseOperator(node(0), 220, now, h).map(d => d.code)).toEqual(['REVIVE_LOOP']);
    expect(diagnoseOperator(node(0), 220, now, h)[0]).toMatchObject({ evidence: 'pattern', operatorAction: false });
    expect(diagnoseOperator(node(0), 220, now, h.slice(0, 3))).toEqual([]);
    expect(diagnoseOperator(node(0), 220, now, [h[0], h[0], h[1]])).toEqual([]);
  });
  it('rejects missing heights, rebound beyond four blocks, and mismatched registrations', () => {
    expect(diagnoseOperator(node(0), 220, now, history().map(h => ({ ...h, recoveredHeight: h.poseBanHeight! + 5 })))).toEqual([]);
    expect(diagnoseOperator(node(0), 220, now, history().map(h => ({ ...h, recoveredHeight: null })))).toEqual([]);
    expect(diagnoseOperator(node(0), 220, now, history().map(h => ({ ...h, proTxHash: 'b'.repeat(64) })))).toEqual([]);
  });
  it('does not reuse a port or registration after IP reassignment', () => {
    expect(inventoryForOperator(node(), [inventory({ port: 9999 })])).toBeUndefined();
    expect(inventoryForOperator(node(), [inventory({ masternodeProTxHash: 'b'.repeat(64) })])).toBeUndefined();
    expect(inventoryForOperator(node(), [inventory()])).toEqual(inventory());
  });
  it('labels old/future/missing version observations without treating them as current proof', () => {
    expect(diagnoseOperator(node(0), 220, now, [], inventory())[0]).toMatchObject({ code: 'OLD_VERSION', evidence: 'probe', operatorAction: false });
    expect(diagnoseOperator(node(0), 220, now, [], inventory({ lastVersionObservedAt: new Date(now.getTime() - 25 * 3600000) }))[0].level).toBe('info');
    expect(diagnoseOperator(node(0), 220, now, [], inventory({ lastVersionObservedAt: null })).some(d => d.code === 'OLD_VERSION')).toBe(false);
    expect(diagnoseOperator(node(0), 220, now, [], inventory({ walletVersion: '23.0.0' })).some(d => d.code === 'OLD_VERSION')).toBe(false);
    expect(diagnoseOperator(node(0), 220, now, [], inventory({ lastVersionObservedAt: new Date(now.getTime() + 1) })).some(d => d.code === 'OLD_VERSION')).toBe(false);
  });
  it('describes behind as lag and a hash mismatch as last-known, never an asserted fork', () => {
    const behind = diagnoseOperator(node(0), 220, now, [], inventory()).find(d => d.code === 'WRONG_CHAIN')!;
    expect(behind.message).toContain('lag alone does not prove a fork'); expect(behind.operatorAction).toBe(false);
    expect(diagnoseOperator(node(0), 220, now, [], inventory({ chainStatus: 'main_chain' })).some(d => d.code === 'WRONG_CHAIN')).toBe(false);
    expect(diagnoseOperator(node(0), 220, now, [], inventory({ chainStatus: 'hash_mismatch' })).at(-1)?.message).toContain('Last-known');
  });
});
describe('DSL shadow diagnosis', () => {
  const main = (...heights: Array<number | null>) => heights.map(blocks => (blocks === null ? null : { chain: 'main', blocks }));
  const v23 = { version: 230000, subversion: '/DeFCoN:23.0.0/' }, reads = [v23, v23], tips = main(161597, 161597);
  const status = (extra = {}) => ({ active: true, enforcing: false, epoch: 6733, activationheight: 145464,
    enforcementheight: 2147483647, epochreports: 0, candidate: {}, ...extra });
  const registry = (...counters: Array<[number, number] | null>) => parseOperatorRegistry(counters.map((c, i) => ({
    proTxHash: (i + 1).toString(16).padStart(64, '0'), state: { service: `198.51.100.${i + 1}:8192`, PoSePenalty: 0,
      PoSeBanHeight: -1, dslBanHeight: -1, ...(c && { missedServiceEpochs: c[0], lastServiceEpoch: c[1] }) } })));
  const mismatch = 'dslstatus does not match its epoch or the chain tip';
  const heightsDiffer = 'dslstatus unavailable or its heights differ from the verified rule';
  const noRule = 'No verified DSL rule for this Core version and network';
  const sameProcess = [{ seconds: 3600, at: 1_000_000 }, { seconds: 3600, at: 1_000_050 }];
  // The registry read at the best ChainLock equals the tip registry unless a test says otherwise.
  const lockHash = 'c'.repeat(64), enforced = { SPORK_19_CHAINLOCKS_ENABLED: true };
  const lockedAt = (nodes: OperatorNode[] | null): DslFinality => ({ chainLock: { blockhash: lockHash, height: 161597 },
    hashes: [lockHash, lockHash], sporks: [enforced, enforced], registry: nodes });
  const assess = (network: unknown[], chain: unknown[], st: unknown, nodes: OperatorNode[], finality = lockedAt(nodes)) =>
    assessDsl(network, chain, sameProcess, st, nodes, finality);
  const codes = (n: OperatorNode, dsl: OperatorDsl) => diagnoseOperator(n, 220, now, [], undefined, dsl).map(d => d.code);
  it('pins the v23.0.0 rule and simulates only from counters written by the latest commitment', () => {
    const nodes = registry([0, 6732], [3, 6732], [4, 6732], [5, 6732], [7, 6700]), dsl = assess(reads, tips, status(), nodes);
    expect(operatorDslSchema.parse(dsl)).toEqual(dsl);
    expect(dsl).toMatchObject({ status: 'shadow', reason: null, coreVersion: '/DeFCoN:23.0.0/', activationHeight: 145464,
      enforcementHeight: 2147483647, currentEpoch: 6733, latestCommittedEpoch: 6732,
      rule: { epochBlocks: 24, suspendEpochs: 4, banEpochs: 5, massOutagePct: 15 },
      simulation: { asOfEpoch: 6732, wouldSuspend: 2, wouldBan: 1, uncounted: 1 } });
    expect(nodes.map(n => codes(n, dsl))).toEqual([[], [], ['DSL_MISSED'], ['DSL_MISSED'], []]);
    const [suspend, ban] = [nodes[2], nodes[3]].map(n => diagnoseOperator(n, 220, now, [], undefined, dsl)[0]);
    expect(suspend).toMatchObject({ level: 'info', evidence: 'chain', operatorAction: false, since: now.toISOString() });
    expect(suspend.message).toContain('last 4 judged service epochs (state as of epoch 6732)');
    expect(suspend.message).toContain('no reward was withheld');
    expect(suspend.hint).toMatch(/^Simulation, not consensus state/);
    expect(suspend.hint).toContain("suspend this node's rewards"); expect(suspend.hint).not.toContain('service-ban this node');
    expect(ban.hint).toContain('suspend rewards and service-ban this node');
  });
  it.each([
    ['one skipped commitment', 6731, tips, true], ['a commitment from a block between the reads', 6733, main(161615, 161616), true],
    ['two skipped commitments', 6730, tips, false],
  ])('keeps the simulation only while the latest commitment is current: %s', (_name, latest, chainTips, current) => {
    const nodes = registry([9, latest]), dsl = assess(reads, chainTips, status(), nodes);
    expect(operatorDslSchema.parse(dsl)).toEqual(dsl);
    expect(dsl).toMatchObject({ status: 'shadow', latestCommittedEpoch: latest, rule: { suspendEpochs: 4 } });
    if (current) {
      expect(dsl).toMatchObject({ reason: null, simulation: { asOfEpoch: latest, wouldSuspend: 1, uncounted: 0 } });
      expect(codes(nodes[0], dsl)).toEqual(['DSL_MISSED']);
    } else {
      expect(dsl).toMatchObject({ simulation: null,
        reason: 'The latest service commitment (epoch 6730) is 2 epochs behind the last closed epoch' });
      expect(codes(nodes[0], dsl)).toEqual([]);
    }
  });
  it('shows no simulation before the first commitment is applied', () => {
    const nodes = registry([0, 0], [0, 0]), dsl = assess(reads, tips, status(), nodes);
    expect(dsl).toMatchObject({ status: 'shadow', latestCommittedEpoch: null, simulation: null,
      reason: 'No service commitment has been applied yet' });
    expect(operatorDslSchema.parse(dsl)).toEqual(dsl);
  });
  it.each([
    ['no version read', [], tips, status(), 'Core version unavailable or changed during the read'],
    ['a failed second version read', [v23, null], tips, status(), 'Core version unavailable or changed during the read'],
    ['a build change during the read', [v23, { ...v23, subversion: '/DeFCoN:23.0.1/' }], tips, status(),
      'Core version unavailable or changed during the read'],
    ['another build', [{ ...v23, subversion: '/DeFCoN:23.0.1/' }, { ...v23, subversion: '/DeFCoN:23.0.1/' }], tips, status(),
      noRule],
    ['another version number', [{ ...v23, version: 230001 }, { ...v23, version: 230001 }], tips, status(),
      noRule],
    ['no tip read', reads, [], status(), 'Chain tip unavailable'],
    ['a failed second tip read', reads, main(161597, null), status(), 'Chain tip unavailable'],
    ['no dslstatus', reads, tips, null, heightsDiffer],
    ['dslstatus without heights', reads, tips, { active: true, enforcing: false, epoch: 1 }, heightsDiffer],
    ['another network', reads, [{ chain: 'test', blocks: 161597 }, { chain: 'test', blocks: 161597 }], status(), noRule],
    ['a network change during the read', reads, [{ chain: 'main', blocks: 161597 }, { chain: 'test', blocks: 161597 }], status(), noRule],
    ['a devnet-style activation height', reads, tips, status({ activationheight: 145440 }), heightsDiffer],
    ['an enforcement height set by configuration', reads, tips, status({ enforcementheight: 161592 }), heightsDiffer],
    ['enforcing at the verified heights', reads, tips, status({ enforcing: true }), mismatch],
    ['enforcement below activation', reads, tips, status({ enforcementheight: 145463 }), heightsDiffer],
    ['enforcing before activation', reads, tips, status({ active: false, enforcing: true }), mismatch],
    ['active in epoch 0', reads, tips, status({ epoch: 0 }), mismatch],
    ['a DSL tick stalled behind the tip', reads, main(161700, 161700), status(), mismatch],
    ['a tick that has not yet seen a boundary block', reads, main(161616, 161616), status(), mismatch],
    ['a tip that moved backwards between the reads', reads, main(161600, 161597), status(), mismatch],
    ['active with every tip below activation', reads, main(145460, 145460), status({ epoch: 6060 }), mismatch],
    ['inactive with a tip past activation', reads, tips, status({ active: false }), mismatch],
    ['an epoch ahead of the tip', reads, tips, status({ epoch: 6740 }), mismatch],
    ['activation reached between the reads (reported inactive)', reads, main(145463, 145464), status({ active: false, epoch: 0 }), mismatch],
    ['activation reached between the reads (reported active)', reads, main(145463, 145464), status({ epoch: 6060 }), mismatch],
    ['a committed epoch ahead of the daemon', reads, main(161560, 161560), status({ epoch: 6731 }),
      'Committed epoch is ahead of the daemon DSL epoch'],
  ])('reports unknown with no rule or DSL_MISSED for %s', (_name, network, chainTips, dslStatus, reason) => {
    const nodes = registry([9, 6732]), dsl = assess(network, chainTips, dslStatus, nodes);
    expect(dsl).toMatchObject({ status: 'unknown', reason, rule: null, simulation: null, latestCommittedEpoch: null });
    expect(operatorDslSchema.safeParse(dsl).success).toBe(true); expect(codes(nodes[0], dsl)).toEqual([]);
  });
  it('accepts states that one tip between the reads can explain', () => {
    expect(assess(reads, main(145470, 145470), status({ epoch: 6061 }), registry([0, 0])).status).toBe('shadow');
    expect(assess(reads, main(145460, 145460), status({ active: false, epoch: 0 }), registry([0, 0]))).toMatchObject({
      status: 'inactive', currentEpoch: null });
    for (const epoch of [6733, 6734]) expect(assess(reads, main(161615, 161616), status({ epoch }), registry([0, 6732])).status).toBe('shadow');
  });
  it('refuses a dslstatus with an enforcement height, whatever the timing of the reads', () => {
    // r3: enforcement reached between the reads; r5: same binary restarted with an enforcement height.
    for (const [chainTips, st, nodes] of [
      [main(149999, 150000), status({ epoch: 6249, enforcementheight: 150000 }), registry([4, 6249])],
      [main(161591, 161592), status({ epoch: 6732, enforcementheight: 161592 }), registry([4, 6732])],
    ] as const) {
      const dsl = assess(reads, [...chainTips], st, nodes);
      expect(dsl).toMatchObject({ status: 'unknown', reason: heightsDiffer, rule: null, simulation: null });
      expect(codes(nodes[0], dsl)).toEqual([]);
    }
  });
  it('rejects a registry holding a commitment block above the last tip read', () => {
    // Block 161592 (applying epoch 6732) was connected for the registry read and disconnected
    // again before the second tip read, so both tip reads say 161591.
    const nodes = registry([4, 6732]);
    const dsl = assess(reads, main(161591, 161591), status({ epoch: 6732 }), nodes);
    expect(dsl).toMatchObject({ status: 'unknown', reason: 'Registered state is newer than the observed chain tip',
      rule: null, simulation: null });
    expect(codes(nodes[0], dsl)).toEqual([]);
    expect(assess(reads, main(161615, 161615), status(), registry([4, 6733])).reason)
      .toBe('Registered state is newer than the observed chain tip');
    expect(assess(reads, main(161615, 161616), status({ epoch: 6734 }), registry([4, 6733])))
      .toMatchObject({ status: 'shadow', simulation: { asOfEpoch: 6733, wouldSuspend: 1 } });
  });
  it('requires every read to come from one daemon process running since before the first read', () => {
    const restarted = 'Daemon uptime unavailable, too short or restarted during the read', nodes = registry([4, 6732]);
    for (const uptime of [
      [{ seconds: 3600, at: 1_000_000 }, { seconds: 0, at: 1_000_050 }], // mainnet -> another daemon -> mainnet again
      [{ seconds: 3600, at: 1_000_000 }, { seconds: 3596, at: 1_000_050 }],
      [{ seconds: 5, at: 1_000_000 }, { seconds: 5, at: 1_000_050 }],
      [{ seconds: 3600, at: 1_000_000 }, null], [], [{ seconds: -1, at: 1_000_000 }, { seconds: 3600, at: 1_000_050 }],
    ]) {
      const dsl = assessDsl(reads, tips, uptime, status(), nodes, lockedAt(nodes));
      expect(dsl).toMatchObject({ status: 'unknown', reason: restarted, rule: null, simulation: null });
      expect(codes(nodes[0], dsl)).toEqual([]);
    }
    for (const uptime of [[{ seconds: 3600, at: 1_000_000 }, { seconds: 3601, at: 1_000_999 }],
      [{ seconds: 10, at: 1_000_000 }, { seconds: 12, at: 1_002_100 }]]) {
      expect(assessDsl(reads, tips, uptime, status(), nodes, lockedAt(nodes)).status).toBe('shadow');
    }
  });
  it('judges freshness at the last tip read', () => {
    expect(assess(reads, main(161591, 161640), status({ epoch: 6732 }), registry([4, 6731]))).toMatchObject({
      status: 'unknown', reason: 'Chain tip advanced more than one epoch during the read', simulation: null });
    const nodes = registry([9, 6731]), dsl = assess(reads, main(161615, 161616), status(), nodes);
    expect(dsl).toMatchObject({ status: 'shadow', simulation: null,
      reason: 'The latest service commitment (epoch 6731) is 2 epochs behind the last closed epoch' });
    expect(codes(nodes[0], dsl)).toEqual([]);
  });
  it('uses the registry DSL state only when it equals the state at the best ChainLock', () => {
    const noLock = 'No enforced ChainLock stayed in the active chain during the read';
    const differs = 'Registered DSL state differs from the state at the best ChainLock';
    // r7: both tips on branch A at 161597; the registry came from branch B, whose block 161592 applied
    // the epoch 6732 commitment that A skipped.
    const fromB = registry([4, 6732], [0, 6732]), atLock = registry([3, 6731], [0, 6731]);
    const dsl = assess(reads, tips, status(), fromB, lockedAt(atLock));
    expect(dsl).toMatchObject({ status: 'unknown', reason: differs, rule: null, simulation: null, latestCommittedEpoch: null });
    expect(codes(fromB[0], dsl)).toEqual([]);
    for (const locked of [registry([4, 6732]), registry([4, 6732], [0, 6732], [0, 6732]), registry([5, 6732], [0, 6732]),
      registry([4, 6731], [0, 6732]),
      registry([4, 6732], null), parseOperatorRegistry([{ proTxHash: 'f'.repeat(64), state: fromB[1].state }, fromB[0]])]) {
      expect(assess(reads, tips, status(), fromB, lockedAt(locked)).reason).toBe(differs);
    }
    const other = 'd'.repeat(64), off = { SPORK_19_CHAINLOCKS_ENABLED: false };
    for (const finality of [
      { ...lockedAt(fromB), chainLock: null }, { ...lockedAt(fromB), chainLock: { blockhash: 'C'.repeat(64) } },
      { ...lockedAt(fromB), hashes: [other, lockHash] }, { ...lockedAt(fromB), hashes: [lockHash, other] },
      { ...lockedAt(fromB), hashes: [lockHash, null] }, { ...lockedAt(fromB), hashes: [] },
      { ...lockedAt(fromB), sporks: [enforced, off] }, { ...lockedAt(fromB), sporks: [off, enforced] },
      { ...lockedAt(fromB), sporks: [enforced, null] }, lockedAt(null),
    ]) {
      const unknown = assess(reads, tips, status(), fromB, finality);
      expect(unknown).toMatchObject({ status: 'unknown', reason: noLock, rule: null, simulation: null });
      expect(codes(fromB[0], unknown)).toEqual([]);
    }
    expect(assess(reads, tips, status(), fromB)).toMatchObject({ status: 'shadow', simulation: { asOfEpoch: 6732, wouldSuspend: 1 } });
    // Before activation no registry state is used, so no ChainLock is needed.
    expect(assess(reads, main(140000, 140000), status({ active: false, epoch: 0 }), fromB, lockedAt(null)).status).toBe('inactive');
  });
  it('treats missing or malformed counters as unknown rather than failing the registry', () => {
    for (const nodes of [registry([9, 6732], null), parseOperatorRegistry([{ proTxHash: id, state: { service: 's',
      PoSePenalty: 0, PoSeBanHeight: -1, dslBanHeight: -1, missedServiceEpochs: -1, lastServiceEpoch: 6732 } }])]) {
      const dsl = assess(reads, tips, status(), nodes);
      expect(dsl).toMatchObject({ status: 'unknown', reason: 'Registered state lacks valid DSL counters', rule: null, simulation: null });
      expect(codes(nodes[0], dsl)).toEqual([]);
    }
  });
  it('emits nothing before activation', () => {
    const nodes = registry([9, 6732]);
    const inactive = assess(reads, main(140000, 140000), status({ active: false, epoch: 0 }), nodes);
    expect(inactive).toMatchObject({ status: 'inactive', reason: null, rule: null, simulation: null, activationHeight: 145464,
      currentEpoch: null });
    expect(codes(nodes[0], inactive)).toEqual([]); operatorDslSchema.parse(inactive);
    expect(diagnoseOperator(nodes[0], 220, now, []).map(d => d.code)).toEqual([]);
  });
  it('checks rule and simulation separately against the status', () => {
    const shadow = assess(reads, tips, status(), registry([4, 6732])), stale = assess(reads, tips, status(), registry([4, 6730]));
    expect(shadow.rule).not.toBeNull(); expect(shadow.simulation).not.toBeNull();
    for (const [name, value, valid] of [
      ['shadow without a rule', { ...shadow, rule: null }, false],
      ['unknown with a rule and no simulation', { ...shadow, status: 'unknown', simulation: null }, false],
      ['unknown with a simulation and no rule', { ...shadow, status: 'unknown', rule: null }, false],
      ['a simulation for another epoch', { ...shadow, simulation: { ...shadow.simulation!, asOfEpoch: 6731 } }, false],
      ['shadow without a simulation or reason', { ...shadow, simulation: null }, false],
      ['shadow without a simulation but with a reason', stale, true],
      ['inactive with neither', { ...shadow, status: 'inactive', rule: null, simulation: null }, true],
    ] as const) expect([name, operatorDslSchema.safeParse(value).success]).toEqual([name, valid]);
  });
});
