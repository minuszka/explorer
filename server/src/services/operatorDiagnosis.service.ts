import type { OperatorDiagnosisData } from '@defcon/shared/dist/contracts';
import { rpcService } from './rpc.service';
import { MasternodeEvent } from '../models/MasternodeEvent';
import { NodeInventory } from '../models/NodeInventory';
import { assessDsl, diagnoseOperator, inventoryForOperator, parseOperatorRegistry } from '../domain/pose/operatorDiagnosis';
import { createSingleFlight } from '../utils/singleFlight';

const singleFlight = createSingleFlight<OperatorDiagnosisData>();
let cached: { at: number; data: OperatorDiagnosisData } | null = null;
export async function getOperatorDiagnosis(): Promise<OperatorDiagnosisData> {
  if (cached && Date.now() - cached.at < 30000) return cached.data;
  return singleFlight.run(async () => {
    // No valid-list/fallback count: the dynamic penalty cap requires the full registry.
    // DSL sources only decide the DSL status; their failure leaves the other diagnoses intact.
    // Build, network and tip are read uncached before and after the state, so the DSL epoch is
    // checked against tips from the same moment. Process uptime is read alone first and last: every
    // other answer arrives between two answers of the process it names, so a restart is seen. The
    // best ChainLock is read next; both anchors confirm its block at its height and the registry is
    // also read there, so the DSL state can be bound to a block that every later chain holds.
    const fresh = { fresh: true };
    const uptime = () => rpcService.call('uptime', [], fresh).then(seconds => ({ seconds, at: Date.now() }), () => null);
    const firstRun = await uptime(), chainLock = await rpcService.call('getbestchainlock', [], fresh).catch(() => null);
    const lockHeight = (chainLock as { height?: unknown } | null)?.height;
    const atLock = typeof lockHeight === 'number' && Number.isInteger(lockHeight) && lockHeight >= 1 ? lockHeight : null;
    const anchor = () => Promise.all([rpcService.call('getnetworkinfo', [], fresh).catch(() => null),
      rpcService.call('getblockchaininfo', [], fresh).catch(() => null),
      atLock === null ? null : rpcService.call('getblockhash', [atLock], fresh).catch(() => null),
      rpcService.call('spork', ['active'], fresh).catch(() => null)]);
    const before = await anchor();
    const [rawRegistry, dslStatus, lockedRegistry] = await Promise.all([rpcService.call('protx', ['list', 'registered', 1]),
      rpcService.call('dslstatus').catch(() => null),
      atLock === null ? null : rpcService.call('protx', ['list', 'registered', 1, atLock]).then(parseOperatorRegistry).catch(() => null)]);
    const registry = parseOperatorRegistry(rawRegistry), after = await anchor(), lastRun = await uptime();
    const dsl = assessDsl([before[0], after[0]], [before[1], after[1]], [firstRun, lastRun], dslStatus, registry,
      { chainLock, hashes: [before[2], after[2]], sporks: [before[3], after[3]], registry: lockedRegistry });
    const now = new Date(), historySince = new Date(now.getTime() - 90 * 86400000);
    const ids = registry.map(n => n.proTxHash);
    const [history, inventory] = await Promise.all([
      MasternodeEvent.find({ eventType: 'ban', proTxHash: { $in: ids }, detectedAt: { $gte: historySince, $lte: now } },
        { proTxHash: 1, poseBanHeight: 1, recoveredHeight: 1, recoveredAt: 1, detectedAt: 1, _id: 0 })
        .sort({ detectedAt: -1 }).limit(10001).lean(),
      NodeInventory.find({ masternodeProTxHash: { $in: ids } },
        { ip: 1, port: 1, masternodeProTxHash: 1, walletVersion: 1, lastVersionObservedAt: 1,
          chainStatus: 1, lastObservedAt: 1, _id: 0 }).lean(),
    ]);
    const historyById = new Map<string, typeof history>();
    for (const event of history.slice(0, 10000)) {
      const key = event.proTxHash?.toLowerCase(); if (!key) continue;
      const rows = historyById.get(key) ?? []; rows.push(event); historyById.set(key, rows);
    }
    const inventoryByEndpoint = new Map(inventory.map(row => [`${row.ip}:${row.port}`, row]));
    const data: OperatorDiagnosisData = {
      generatedAt: now.toISOString(), registeredCount: registry.length, maxPenalty: Math.max(100, registry.length),
      historySince: historySince.toISOString(), historyLimited: true, dsl,
      nodes: registry.map(node => ({ proTxHash: node.proTxHash, service: node.state.service,
        operatorDiagnosis: diagnoseOperator(node, registry.length, now, historyById.get(node.proTxHash) ?? [],
          inventoryForOperator(node, [inventoryByEndpoint.get(node.state.service.replace(/^\[([^\]]+)\]/, '$1'))].filter(row => row !== undefined)), dsl) })),
    };
    cached = { at: Date.now(), data };
    return data;
  });
}
