import { rpcService } from '../src/services/rpc.service';
import { MasternodeEvent } from '../src/models/MasternodeEvent';
import { NodeInventory } from '../src/models/NodeInventory';
import { getOperatorDiagnosis } from '../src/services/operatorDiagnosis.service';
import { operatorDiagnosisDataSchema } from '@defcon/shared/dist/contracts';
vi.mock('../src/services/rpc.service', () => ({ rpcService: { call: vi.fn() } }));
const now = new Date('2026-10-07T12:00:00Z'), id = 'a'.repeat(64);
const registered = (missedServiceEpochs = 4, lastServiceEpoch = 6732) => [{ proTxHash: id, state: { service: '198.51.100.1:8192',
  PoSePenalty: 50, PoSeBanHeight: -1, dslBanHeight: -1, missedServiceEpochs, lastServiceEpoch } }];
const dslStatus = { active: true, enforcing: false, epoch: 6733, activationheight: 145464, enforcementheight: 2147483647 };
const v23 = { version: 230000, subversion: '/DeFCoN:23.0.0/' };
const lock = { blockhash: 'c'.repeat(64), height: 161597, known_block: true }, enforced = { SPORK_19_CHAINLOCKS_ENABLED: true };
// `versions` and `tips` (heights on main, or chain objects) answer the uncached anchor reads in order;
// `locked` is the registry read at the best ChainLock height.
const rpc = (dsl: () => Promise<unknown>, versions: unknown[] = [v23, v23], tips: unknown[] = [161597, 161597],
  registry = registered(), uptimes: unknown[] = [3600, 3600], locked: unknown = registry) => {
  let version = 0, tip = 0, up = 0;
  const chainAt = (t: unknown) => (typeof t === 'number' ? { chain: 'main', blocks: t } : t);
  return vi.mocked(rpcService.call).mockImplementation(async (method: string, params?: unknown[]) =>
    method === 'protx' ? (params?.length === 4 ? locked : registry)
    : method === 'getnetworkinfo' ? versions[version++] : method === 'getblockchaininfo' ? chainAt(tips[tip++])
    : method === 'uptime' ? uptimes[up++] : method === 'getbestchainlock' ? lock
    : method === 'getblockhash' ? lock.blockhash : method === 'spork' ? enforced : dsl());
};
const stubHistory = () => {
  const limit = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  vi.spyOn(MasternodeEvent, 'find').mockReturnValue({ sort: vi.fn().mockReturnValue({ limit }) } as never);
  vi.spyOn(NodeInventory, 'find').mockReturnValue({ lean: vi.fn().mockResolvedValue([]) } as never);
  return limit;
};
describe('operator diagnosis source boundaries', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('uses registered RPC only, bounded retained ban metadata, and shares cached results', async () => {
    rpc(async () => dslStatus); const limit = stubHistory();
    const results = await Promise.all([getOperatorDiagnosis(), getOperatorDiagnosis()]);
    expect(results[0]).toBe(results[1]);
    const fresh = { fresh: true }, up = ['uptime', [], fresh], anchor = [['getnetworkinfo', [], fresh], ['getblockchaininfo', [], fresh],
      ['getblockhash', [161597], fresh], ['spork', ['active'], fresh]];
    expect(vi.mocked(rpcService.call).mock.calls).toEqual([up, ['getbestchainlock', [], fresh], ...anchor,
      ['protx', ['list', 'registered', 1]], ['dslstatus'], ['protx', ['list', 'registered', 1, 161597]], ...anchor, up]);
    expect(limit).toHaveBeenCalledWith(10001); expect(results[0].maxPenalty).toBe(100);
    expect(results[0].nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG', 'DSL_MISSED']);
    expect(results[0].dsl).toMatchObject({ status: 'shadow', latestCommittedEpoch: 6732,
      simulation: { asOfEpoch: 6732, wouldSuspend: 1, wouldBan: 0, uncounted: 0 } });
    expect(operatorDiagnosisDataSchema.parse(results[0])).toEqual(results[0]);
    expect(await getOperatorDiagnosis()).toBe(results[0]);
  });
  it('never returns an old action snapshot after RPC failure or incomplete state', async () => {
    const find = vi.spyOn(MasternodeEvent, 'find');
    vi.setSystemTime(new Date(now.getTime() + 31000));
    vi.mocked(rpcService.call).mockRejectedValue(new Error('RPC unavailable'));
    await expect(getOperatorDiagnosis()).rejects.toThrow('RPC unavailable');
    vi.mocked(rpcService.call).mockResolvedValue([{ proTxHash: id, state: { PoSePenalty: 50 } }]);
    await expect(getOperatorDiagnosis()).rejects.toThrow();
    expect(find).not.toHaveBeenCalled();
  });
  it('keeps the other diagnoses when the DSL source fails and never reuses a shadow verdict', async () => {
    vi.setSystemTime(new Date(now.getTime() + 62000)); stubHistory();
    rpc(async () => { throw new Error('Method not found'); });
    const data = await getOperatorDiagnosis();
    expect(data.dsl).toMatchObject({ status: 'unknown', reason: 'dslstatus unavailable or its heights differ from the verified rule',
      rule: null, simulation: null });
    expect(data.nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG']);
    expect(operatorDiagnosisDataSchema.parse(data)).toEqual(data);
  });
  it('reports DSL unknown when the daemon changes build between the version reads', async () => {
    vi.setSystemTime(new Date(now.getTime() + 93000)); stubHistory();
    rpc(async () => dslStatus, [v23, { ...v23, version: 230100, subversion: '/DeFCoN:23.1.0/' }]);
    const data = await getOperatorDiagnosis();
    expect(data.dsl).toMatchObject({ status: 'unknown', reason: 'Core version unavailable or changed during the read',
      rule: null, simulation: null });
    expect(data.nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG']);
  });
  it('reports DSL unknown when the DSL epoch has stalled behind the chain tip', async () => {
    vi.setSystemTime(new Date(now.getTime() + 124000)); stubHistory();
    rpc(async () => dslStatus, [v23, v23], [161700, 161701]);
    const data = await getOperatorDiagnosis();
    expect(data.dsl).toMatchObject({ status: 'unknown', reason: 'dslstatus does not match its epoch or the chain tip',
      simulation: null });
    expect(data.nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG']);
  });
  it('reports DSL unknown for a daemon whose enforcement height is not the compiled mainnet one', async () => {
    vi.setSystemTime(new Date(now.getTime() + 155000)); stubHistory();
    rpc(async () => ({ ...dslStatus, epoch: 6732, enforcementheight: 161592 }), [v23, v23], [161591, 161592], registered(4, 6732));
    const data = await getOperatorDiagnosis();
    expect(data.dsl).toMatchObject({ status: 'unknown',
      reason: 'dslstatus unavailable or its heights differ from the verified rule', simulation: null });
    expect(data.nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG']);
  });
  it('reports DSL unknown when the registry saw a block that was gone by the second tip read', async () => {
    vi.setSystemTime(new Date(now.getTime() + 186000)); stubHistory();
    rpc(async () => ({ ...dslStatus, epoch: 6732 }), [v23, v23], [161591, 161591], registered(4, 6732));
    const data = await getOperatorDiagnosis();
    expect(data.dsl).toMatchObject({ status: 'unknown', reason: 'Registered state is newer than the observed chain tip',
      simulation: null });
    expect(data.nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG']);
  });
  it('reports DSL unknown off mainnet', async () => {
    vi.setSystemTime(new Date(now.getTime() + 217000)); stubHistory();
    rpc(async () => dslStatus, [v23, v23], [{ chain: 'test', blocks: 161597 }, { chain: 'test', blocks: 161597 }]);
    const data = await getOperatorDiagnosis();
    expect(data.dsl).toMatchObject({ status: 'unknown', reason: 'No verified DSL rule for this Core version and network' });
    expect(data.nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG']);
  });
  it('reports DSL unknown when the daemon restarted between the anchor reads', async () => {
    vi.setSystemTime(new Date(now.getTime() + 248000)); stubHistory();
    rpc(async () => dslStatus, [v23, v23], [161597, 161597], registered(), [3600, 0]);
    const data = await getOperatorDiagnosis();
    expect(data.dsl).toMatchObject({ status: 'unknown',
      reason: 'Daemon uptime unavailable, too short or restarted during the read', simulation: null });
    expect(data.nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG']);
  });
  it('reads uptime alone, so every other answer arrives between the two uptime answers', async () => {
    vi.setSystemTime(new Date(now.getTime() + 279000)); stubHistory();
    const answer = rpc(async () => dslStatus).getMockImplementation()!;
    let open = 0, uptimeOpen = 0; const overlaps: string[] = [];
    vi.mocked(rpcService.call).mockImplementation(async (method, params, options) => {
      if (uptimeOpen > 0 || (method === 'uptime' && open > 0)) overlaps.push(method);
      open++; if (method === 'uptime') uptimeOpen++;
      try { return await answer(method, params, options); } finally { open--; if (method === 'uptime') uptimeOpen--; }
    });
    const data = await getOperatorDiagnosis();
    expect(overlaps).toEqual([]); expect(data.dsl.status).toBe('shadow');
  });
  it('reports DSL unknown when the registry came from a branch the ChainLocked chain does not hold', async () => {
    vi.setSystemTime(new Date(now.getTime() + 310000)); stubHistory();
    // r7: the tip registry saw branch B's epoch 6732 commitment; at the ChainLock, branch A skipped it.
    rpc(async () => dslStatus, [v23, v23], [161597, 161597], registered(4, 6732), [3600, 3600], registered(3, 6731));
    const data = await getOperatorDiagnosis();
    expect(data.dsl).toMatchObject({ status: 'unknown', reason: 'Registered DSL state differs from the state at the best ChainLock',
      simulation: null });
    expect(data.nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG']);
    expect(operatorDiagnosisDataSchema.parse(data)).toEqual(data);
  });
  it.each([
    ['the ChainLocked block was not yet at its height in the first anchor', 465000, 'getblockhash', ['d'.repeat(64), lock.blockhash]],
    ['the ChainLocked block left its height by the second anchor', 496000, 'getblockhash', [lock.blockhash, 'd'.repeat(64)]],
    ['spork 19 was off in the first anchor', 527000, 'spork', [{ SPORK_19_CHAINLOCKS_ENABLED: false }, enforced]],
    ['spork 19 was off by the second anchor', 558000, 'spork', [enforced, { SPORK_19_CHAINLOCKS_ENABLED: false }]],
  ])('reports DSL unknown when %s', async (_name, offset, varying, answers) => {
    vi.setSystemTime(new Date(now.getTime() + offset)); stubHistory();
    const answer = rpc(async () => dslStatus).getMockImplementation()!; let read = 0;
    vi.mocked(rpcService.call).mockImplementation(async (method, params, options) =>
      method === varying ? answers[read++] : answer(method, params, options));
    const data = await getOperatorDiagnosis();
    expect(data.dsl).toMatchObject({ status: 'unknown', reason: 'No enforced ChainLock stayed in the active chain during the read' });
    expect(data.nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG']);
  });
  it.each([
    ['no ChainLock is known', 341000, (method: string) => method === 'getbestchainlock'],
    ['the registry at the ChainLock height cannot be read', 372000, (method: string, params?: unknown[]) => method === 'protx' && params?.length === 4],
    ['the ChainLocked block cannot be read at its height', 403000, (method: string) => method === 'getblockhash'],
    ['spork 19 cannot be read', 434000, (method: string) => method === 'spork'],
  ])('keeps the other diagnoses and reports DSL unknown when %s', async (_name, offset, fails) => {
    vi.setSystemTime(new Date(now.getTime() + offset)); stubHistory();
    const answer = rpc(async () => dslStatus).getMockImplementation()!;
    vi.mocked(rpcService.call).mockImplementation(async (method, params, options) =>
      fails(method, params) ? Promise.reject(new Error('unavailable')) : answer(method, params, options));
    const data = await getOperatorDiagnosis();
    expect(data.dsl).toMatchObject({ status: 'unknown', reason: 'No enforced ChainLock stayed in the active chain during the read',
      simulation: null });
    expect(data.nodes[0].operatorDiagnosis.map(d => d.code)).toEqual(['BAN_NEXT_DKG']);
  });
});
