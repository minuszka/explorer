import { z } from 'zod';
import type { OperatorDiagnosis, OperatorDsl } from '@defcon/shared/dist/contracts';

const height = z.number().int().min(-1).max(2147483647);
const epoch = z.number().int().min(0).max(4294967295);
export function parseOperatorRegistry(value: unknown) {
  const nodes = z.array(z.object({
    proTxHash: z.string().regex(/^[a-fA-F0-9]{64}$/).transform(s => s.toLowerCase()),
    // Missing or malformed DSL counters become undefined; assessDsl then reports DSL unknown.
    state: z.object({ service: z.string(), PoSePenalty: z.number().int().nonnegative(),
      PoSeBanHeight: height, dslBanHeight: height,
      missedServiceEpochs: epoch.optional().catch(undefined), lastServiceEpoch: epoch.optional().catch(undefined) }),
  })).min(1).max(20000).parse(value);
  if (new Set(nodes.map(n => n.proTxHash)).size !== nodes.length) throw new Error('Duplicate registration');
  return nodes;
}
export type OperatorNode = ReturnType<typeof parseOperatorRegistry>[number];
export type OperatorInventory = {
  ip: string; port: number; masternodeProTxHash?: string | null;
  walletVersion?: string | null; lastVersionObservedAt?: Date | null;
  chainStatus?: string | null; lastObservedAt?: Date | null;
};
export type ReviveHistory = {
  proTxHash?: string | null; poseBanHeight?: number | null; recoveredHeight?: number | null;
  detectedAt?: Date; recoveredAt?: Date | null;
};

/** Exact endpoint and registration match; a reused IP must not inherit evidence. */
export function inventoryForOperator(node: OperatorNode, rows: OperatorInventory[]) {
  return rows.find(r => node.state.service === (r.ip.includes(':') ? `[${r.ip}]:${r.port}` : `${r.ip}:${r.port}`)
    && (!r.masternodeProTxHash || r.masternodeProTxHash.toLowerCase() === node.proTxHash));
}
// The daemon reports DSL heights but not its rule constants, so the rule is pinned to the exact
// build whose source was read (tag v23.0.0: consensus/params.h, chainparams.cpp) and to mainnet,
// where the DSL heights are compiled in: activation at the v23 height 144888 + 576, enforcement
// never set. Only devnet and regtest read DSL heights from arguments.
const DSL_RULES = [{ version: 230000, subversion: '/DeFCoN:23.0.0/', chain: 'main', activationHeight: 145464,
  enforcementHeight: 2147483647, rule: {
    source: 'DeFCoN Core v23.0.0 consensus defaults', epochBlocks: 24, suspendEpochs: 4, banEpochs: 5, massOutagePct: 15 } }];
const blockHeight = z.number().int().min(0).max(2147483647);
const networkInfo = z.object({ version: z.number().int(), subversion: z.string() });
const chainInfo = z.object({ chain: z.string(), blocks: blockHeight });
const dslStatus = z.object({ active: z.boolean(), enforcing: z.boolean(), epoch,
  activationheight: blockHeight, enforcementheight: blockHeight });
const daemonUptime = z.object({ seconds: z.number().int().min(0), at: z.number() });
const blockHash = z.string().regex(/^[0-9a-f]{64}$/);
const chainLockInfo = z.object({ blockhash: blockHash });
// Without spork 19 a block conflicting with a ChainLock is still connected (llmq/chainlocks.cpp).
const chainLocksEnforced = z.object({ SPORK_19_CHAINLOCKS_ENABLED: z.literal(true) });
/** The best ChainLock, the getblockhash (at its height) and `spork active` reads taken before and
 *  after the registry, and the registry read at that height (null when unavailable). */
export type DslFinality = { chainLock: unknown; hashes: unknown[]; sporks: unknown[]; registry: OperatorNode[] | null };
// Commitments can be skipped; one missing (or a block arriving between the reads) is tolerated.
const MAX_COMMITMENT_LAG = 1;
// `uptime` counts whole seconds since the process started, so `at - seconds` estimates the start
// to about a second plus latency. A process started after the first read (a restart, possibly into
// another network) estimates a start later than the first by more than the first uptime less ~3 s;
// a process younger than MIN_UPTIME_S cannot be told apart and is refused.
const MIN_UPTIME_S = 10, START_SLACK_MS = 3000;
/** Every read parsed, or null when there is none or any one fails. */
function parsedAll<T>(schema: z.ZodType<T>, values: unknown[]): T[] | null {
  const out = values.map(v => schema.safeParse(v)).map(r => (r.success ? r.data : null));
  return out.length > 0 && out.every(v => v !== null) ? (out as T[]) : null;
}
/** Missing, mismatched or inconsistent sources make DSL unknown; no rule is assumed. `network`,
 *  `chain` and `uptime` hold the getnetworkinfo, getblockchaininfo and uptime reads (with the
 *  local time each answer arrived) taken before and after the other sources. */
export function assessDsl(network: unknown[], chain: unknown[], uptime: unknown[], status: unknown,
  registry: OperatorNode[], finality: DslFinality): OperatorDsl {
  const empty = { reason: null, coreVersion: null, activationHeight: null, enforcementHeight: null,
    currentEpoch: null, latestCommittedEpoch: null, rule: null, simulation: null };
  const reads = parsedAll(networkInfo, network), net = reads?.[0];
  if (!reads || !net || reads.some(r => r.version !== net.version || r.subversion !== net.subversion)) {
    return { ...empty, status: 'unknown', reason: 'Core version unavailable or changed during the read' };
  }
  const coreVersion = net.subversion, runs = parsedAll(daemonUptime, uptime), starts = runs?.map(r => r.at - r.seconds * 1000) ?? [];
  // All reads must come from one daemon process, running since before the first read.
  if (!runs || runs[0].seconds < MIN_UPTIME_S || Math.max(...starts) - Math.min(...starts) > START_SLACK_MS) {
    return { ...empty, status: 'unknown', coreVersion, reason: 'Daemon uptime unavailable, too short or restarted during the read' };
  }
  const tips = parsedAll(chainInfo, chain);
  if (!tips) return { ...empty, status: 'unknown', coreVersion, reason: 'Chain tip unavailable' };
  const profile = DSL_RULES.find(p => p.version === net.version && p.subversion === coreVersion
    && tips.every(t => t.chain === p.chain));
  if (!profile) return { ...empty, status: 'unknown', coreVersion, reason: 'No verified DSL rule for this Core version and network' };
  const { rule } = profile, parsed = dslStatus.safeParse(status), s = parsed.success ? parsed.data : null;
  if (!s || s.activationheight !== profile.activationHeight || s.enforcementheight !== profile.enforcementHeight) {
    return { ...empty, status: 'unknown', coreVersion, reason: 'dslstatus unavailable or its heights differ from the verified rule' };
  }
  // dslstatus and the registry are read in parallel between the first and last tip read, so each
  // may describe any tip in that range. `active` and `enforcing` must hold for the whole range (a
  // DSL height crossed during the read is ambiguous), and once active `epoch`, floor(tip /
  // epochBlocks) from the last DSL tick (which does not run before activation or while syncing),
  // must contain a tip from it. With enforcement never set, `enforcing` must be false.
  const first = tips[0].blocks, last = tips[tips.length - 1].blocks, B = rule.epochBlocks, start = s.epoch * B;
  const holds = (reached: boolean, height: number) => (reached ? first >= height : last < height);
  if (first > last || !holds(s.active, s.activationheight) || !holds(s.enforcing, s.enforcementheight)
    || (s.active && (start > last || start + B - 1 < first))) {
    return { ...empty, status: 'unknown', coreVersion, reason: 'dslstatus does not match its epoch or the chain tip' };
  }
  // Freshness is judged at the last tip read; a read during which the tip crossed more than one
  // epoch boundary has no single current epoch.
  const tipEpoch = Math.floor(last / B);
  if (tipEpoch - Math.floor(first / B) > 1) {
    return { ...empty, status: 'unknown', coreVersion, reason: 'Chain tip advanced more than one epoch during the read' };
  }
  const base = { ...empty, coreVersion, activationHeight: s.activationheight,
    enforcementHeight: s.enforcementheight, currentEpoch: s.active ? s.epoch : null };
  if (!s.active) return { ...base, status: 'inactive' };
  // The tip registry may come from a branch that the last tip read no longer holds (a reorg and its
  // reversal between the reads). Its DSL state is used only when it equals the state at the best
  // ChainLock: that block is at its height in both anchors, and while spork 19 is active no block
  // conflicting with it is connected, so every chain read from the first anchor on holds it.
  const lock = chainLockInfo.safeParse(finality.chainLock), lockHash = lock.success ? lock.data.blockhash : null;
  const hashes = parsedAll(blockHash, finality.hashes), sporks = parsedAll(chainLocksEnforced, finality.sporks);
  if (!lockHash || !hashes || !sporks || hashes.some(h => h !== lockHash) || !finality.registry) {
    return { ...base, status: 'unknown', reason: 'No enforced ChainLock stayed in the active chain during the read' };
  }
  const locked = new Map(finality.registry.map(n => [n.proTxHash, n.state]));
  if (locked.size !== registry.length || registry.some(n => { const l = locked.get(n.proTxHash);
    return !l || l.missedServiceEpochs !== n.state.missedServiceEpochs || l.lastServiceEpoch !== n.state.lastServiceEpoch; })) {
    return { ...base, status: 'unknown', reason: 'Registered DSL state differs from the state at the best ChainLock' };
  }
  const states = registry.map(n => n.state);
  if (states.some(n => n.missedServiceEpochs === undefined || n.lastServiceEpoch === undefined)) {
    return { ...base, status: 'unknown', reason: 'Registered state lacks valid DSL counters' };
  }
  // 0 is the counter default; an epoch-0 commitment needs activation at height 0, so 0 means none applied yet.
  const max = states.reduce((m, n) => Math.max(m, n.lastServiceEpoch!), 0), latest = max > 0 ? max : null;
  // Epoch E is committed in the block that opens E + 1. A commitment for the current epoch can only
  // come from a block arriving between the reads; a later one is inconsistent.
  if (latest !== null && latest > s.epoch) {
    return { ...base, status: 'unknown', reason: 'Committed epoch is ahead of the daemon DSL epoch' };
  }
  // That block is (E + 1) * epochBlocks. A registry holding a block above the last tip read was not
  // taken inside the observed range (a block connected and disconnected between the reads).
  if (latest !== null && (latest + 1) * B > last) {
    return { ...base, status: 'unknown', reason: 'Registered state is newer than the observed chain tip' };
  }
  const shadow = { ...base, status: 'shadow' as const, rule, latestCommittedEpoch: latest };
  if (latest === null) return { ...shadow, reason: 'No service commitment has been applied yet' };
  const lag = tipEpoch - 1 - latest;
  if (lag > MAX_COMMITMENT_LAG) {
    return { ...shadow, reason: `The latest service commitment (epoch ${latest}) is ${lag} epochs behind the last closed epoch` };
  }
  // Only counters written by that commitment are current; the rest are reported as `uncounted`.
  const missed = states.filter(n => n.lastServiceEpoch === latest).map(n => n.missedServiceEpochs!);
  return { ...shadow, simulation: { asOfEpoch: latest, wouldSuspend: missed.filter(m => m >= rule.suspendEpochs).length,
    wouldBan: missed.filter(m => m >= rule.banEpochs).length, uncounted: states.length - missed.length } };
}
const date = (value: Date | null | undefined, now: number) => {
  const t = value?.getTime(); return t != null && Number.isFinite(t) && t <= now ? t : null;
};
export function diagnoseOperator(node: OperatorNode, registeredCount: number, now: Date,
  history: ReviveHistory[], inventory?: OperatorInventory, dsl?: OperatorDsl): OperatorDiagnosis[] {
  const results: OperatorDiagnosis[] = [], ms = now.getTime();
  const maximum = Math.max(100, registeredCount), amount = Math.floor(maximum * 66 / 100), threshold = maximum - amount;
  const penalty = node.state.PoSePenalty;
  if (node.state.PoSeBanHeight === -1 && node.state.dslBanHeight === -1 && penalty >= threshold) {
    const blocks = penalty - threshold + 1;
    results.push({ code: 'BAN_NEXT_DKG', level: 'action', evidence: 'chain', since: now.toISOString(),
      source: 'protx list registered', operatorAction: true,
      message: `At the observed penalty (${penalty}/${maximum}), another invalid DKG membership can reach the ban threshold.`,
      hint: `Check DKG connectivity and logs. Below this threshold after ${blocks} score-decreasing block(s), assuming no new penalties, suspension or registry changes. This is a conditional risk, not a ban prediction.` });
  }
  // Recovery belongs to the earlier ban document. Pair stable identities using
  // actual ban/recovery heights, never detection-height or wall-clock estimates.
  const events = history.filter(e => e.proTxHash?.toLowerCase() === node.proTxHash
    && Number.isSafeInteger(e.poseBanHeight) && e.poseBanHeight! > 0 && date(e.detectedAt, ms) != null);
  const bans = new Map(events.map(e => [e.poseBanHeight!, date(e.detectedAt, ms)!]));
  const rebounds = new Map<number, number>();
  for (const e of events) {
    const h = e.recoveredHeight, at = date(e.recoveredAt, ms);
    if (!Number.isSafeInteger(h) || h! <= e.poseBanHeight! || at == null) continue;
    if ([1, 2, 3, 4].some(delta => (bans.get(h! + delta) ?? -1) >= at)) rebounds.set(h!, at);
  }
  const times = [...rebounds.values()].sort((a, b) => a - b);
  if (times.length >= 3) results.push({ code: 'REVIVE_LOOP', level: 'action', evidence: 'pattern',
    since: new Date(times[0]).toISOString(), source: 'MasternodeEvent ban/recovery (90-day retained history)', operatorAction: false,
    message: `${times.length} recorded revivals were followed by another ban within 1–4 blocks.`,
    hint: 'Pause automated revival and investigate the node before reviving again. This history pattern does not identify the ban cause or prove a script is running.' });
  const versionAt = date(inventory?.lastVersionObservedAt, ms);
  const version = inventory?.walletVersion?.match(/^(?:\/?DeFCoN:|v)?(\d+)\.\d+/i);
  if (version && Number(version[1]) < 23 && versionAt != null) results.push({
    code: 'OLD_VERSION', level: ms - versionAt <= 86400000 ? 'warn' : 'info', evidence: 'probe',
    since: new Date(versionAt).toISOString(), source: 'NodeInventory last version observation', operatorAction: false,
    message: `Last observed version: ${inventory?.walletVersion}. This may have changed since the observation.`,
    hint: 'Verify the running daemon version and upgrade if it is still below v23.' });
  const chainAt = date(inventory?.lastObservedAt, ms);
  if (chainAt != null && ['behind', 'hash_mismatch'].includes(inventory?.chainStatus ?? '')) results.push({
    code: 'WRONG_CHAIN', level: 'warn', evidence: 'probe', since: new Date(chainAt).toISOString(),
    source: 'NodeInventory last-known chain classification; inventory update time', operatorAction: false,
    message: inventory?.chainStatus === 'behind' ? 'Last-known inventory state is behind the reference chain; lag alone does not prove a fork.'
      : 'Last-known inventory state has a different hash at the reference height.',
    hint: 'Compare the current height and block hash with the reference node. The inventory update time is not an independent chain-probe timestamp.' });
  // The counter is consensus state even in shadow mode; only suspension and ban wait for enforcement.
  // It is used only when the latest commitment is current and wrote this node's counter.
  const missed = node.state.missedServiceEpochs;
  if (dsl?.status === 'shadow' && dsl.rule && dsl.simulation && node.state.lastServiceEpoch === dsl.simulation.asOfEpoch
    && missed !== undefined && missed >= dsl.rule.suspendEpochs) {
    const { source, suspendEpochs, banEpochs } = dsl.rule;
    results.push({ code: 'DSL_MISSED', level: 'info', evidence: 'chain', since: now.toISOString(),
      source: 'protx list registered (missedServiceEpochs); dslstatus', operatorAction: false,
      message: `Committed Sentinel verdicts mark this node missed in its last ${missed} judged service epochs (state as of epoch ${node.state.lastServiceEpoch}). DSL runs in shadow mode: no reward was withheld.`,
      hint: `Simulation, not consensus state: under the ${source} (${suspendEpochs} missed epochs suspend rewards, ${banEpochs} service-ban), enforcement would ${missed >= banEpochs ? 'suspend rewards and service-ban this node' : 'suspend this node\'s rewards'}. Check that its service port is reachable from other masternodes. Mass-outage and unobserved epochs are not counted.` });
  }
  return results;
}
