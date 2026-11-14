import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { COIN } from '@defcon/shared';
import { Address } from '../../models/Address';
import { Transaction } from '../../models/Transaction';
import { withCachePolicy } from '../../middleware/cachePolicy';
import type { SatLike } from '../../utils/amounts';
import { satToBigInt, satToCoin } from '../../utils/amounts';
import { exactSat, stakerOf, type RoleTx } from '../../utils/blockRoles';
import {
  addressParamSchema,
  firstValidationIssueMessage,
  sendInternalError,
  sendValidationError,
} from '../../utils/validation';

const router = Router();
const GRAPH_CACHE_TTL_MS = 20_000;
const GRAPH_STALE_MAX_MS = 90_000;
const GRAPH_CACHE_LIMIT = 24;
type GraphResponsePayload = { success: true; data: unknown };
const graphCache = new Map<string, { atMs: number; payload: GraphResponsePayload }>();
const graphInFlight = new Map<string, Promise<GraphResponsePayload>>();
const REWARDS_CACHE_TTL_MS = 15_000;
const REWARDS_STALE_MAX_MS = 90_000;
const REWARDS_CACHE_LIMIT = 128;
type RewardsResponsePayload = {
  success: true;
  data: {
    address: string;
    coinbaseTxCount: number;
    coinbaseTotal: number;
    lastCoinbaseAt: number | null;
    stakeTxCount: number;
    stakeTotal: number;
    lastStakeAt: number | null;
  };
};
const rewardsCache = new Map<string, { atMs: number; payload: RewardsResponsePayload }>();
const rewardsInFlight = new Map<string, Promise<RewardsResponsePayload>>();

// Cached detection of whether involvedAddresses is populated in this DB.
// Mirrors the same pattern used in addresses.routes.ts.
let graphInvolvedFieldDetected: boolean | null = null;
async function graphHasInvolvedField(): Promise<boolean> {
  if (graphInvolvedFieldDetected !== null) return graphInvolvedFieldDetected;
  const sample = await Transaction.findOne({ involvedAddresses: { $exists: true, $ne: [] } })
    .select({ _id: 1 })
    .lean();
  graphInvolvedFieldDetected = sample != null;
  return graphInvolvedFieldDetected;
}

function buildFrontierTxQuery(frontierAddresses: string[], useInvolved: boolean) {
  if (useInvolved) {
    return { involvedAddresses: { $in: frontierAddresses } };
  }
  return {
    $or: [
      { 'vin.address': { $in: frontierAddresses } },
      { 'vout.scriptPubKey.addresses': { $in: frontierAddresses } },
    ],
  };
}

function getGraphCache(key: string): GraphResponsePayload | null {
  const entry = graphCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.atMs >= GRAPH_CACHE_TTL_MS) {
    // Retain until the longer stale deadline so a failed refresh can fall back.
    return null;
  }
  // LRU touch
  graphCache.delete(key);
  graphCache.set(key, entry);
  return entry.payload;
}

function getGraphStaleCache(key: string): GraphResponsePayload | null {
  const entry = graphCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.atMs >= GRAPH_STALE_MAX_MS) {
    graphCache.delete(key);
    return null;
  }
  return entry.payload;
}

function setGraphCache(key: string, payload: GraphResponsePayload): void {
  if (graphCache.has(key)) graphCache.delete(key);
  while (graphCache.size >= GRAPH_CACHE_LIMIT) {
    const oldestKey = graphCache.keys().next().value;
    if (!oldestKey) break;
    graphCache.delete(oldestKey);
  }
  graphCache.set(key, { atMs: Date.now(), payload });
}

function getRewardsCache(key: string): RewardsResponsePayload | null {
  const entry = rewardsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.atMs >= REWARDS_CACHE_TTL_MS) {
    // Retain until the longer stale deadline so a failed refresh can fall back.
    return null;
  }
  rewardsCache.delete(key);
  rewardsCache.set(key, entry);
  return entry.payload;
}

function getRewardsStaleCache(key: string): RewardsResponsePayload | null {
  const entry = rewardsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.atMs >= REWARDS_STALE_MAX_MS) {
    rewardsCache.delete(key);
    return null;
  }
  return entry.payload;
}

function setRewardsCache(key: string, payload: RewardsResponsePayload): void {
  if (rewardsCache.has(key)) rewardsCache.delete(key);
  while (rewardsCache.size >= REWARDS_CACHE_LIMIT) {
    const oldestKey = rewardsCache.keys().next().value;
    if (!oldestKey) break;
    rewardsCache.delete(oldestKey);
  }
  rewardsCache.set(key, { atMs: Date.now(), payload });
}

type AggResult = {
  _id: null;
  totalSat: unknown;
  count: number;
  lastBlocktime: number | null;
};
type GraphTxLean = {
  txid: string;
  blocktime: number;
  involvedAddresses?: string[];
  vin?: Array<{ address?: string; valueSat?: SatLike }>;
  vout?: Array<{ valueSat?: SatLike; scriptPubKey?: { addresses?: string[] } }>;
};

type GraphNodeResult = {
  id: string;
  address: string;
  balance: number;
  txCount: number;
  isRoot: boolean;
  depth: number;
  group: number;
};

type GraphEdgeResult = {
  source: string;
  target: string;
  txCount: number;
  totalAmount: number;
  lastBlocktime: number | null;
};

type EdgeAccumulator = {
  source: string;
  target: string;
  txCount: number;
  totalSat: bigint;
  lastBlocktime: number | null;
};

type CandidateScore = {
  score: number;
  parentScores: Map<string, number>;
};

const graphQuerySchema = z.object({
  depth: z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? 2 : Number(v)),
    z.number().int().min(1).max(3)
  ),
  maxNodes: z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? 140 : Number(v)),
    z.number().int().min(20).max(350)
  ),
  maxEdges: z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? 700 : Number(v)),
    z.number().int().min(20).max(1500)
  ),
});

function isGraphAddressCandidate(address: unknown): address is string {
  if (typeof address !== 'string') return false;
  const trimmed = address.trim();
  return (
    trimmed.length >= 26 &&
    trimmed.length <= 35 &&
    trimmed.startsWith(COIN.ADDRESS_PREFIX)
  );
}

function addToBigIntMap(target: Map<string, bigint>, key: string, amount: bigint): void {
  if (amount <= 0n) return;
  target.set(key, (target.get(key) || 0n) + amount);
}

function allocateOutputToAddresses(
  outputValueSat: bigint,
  addresses: string[]
): Array<{ address: string; amountSat: bigint }> {
  const clean = addresses.filter((address) => isGraphAddressCandidate(address));
  if (outputValueSat <= 0n || clean.length === 0) return [];

  const divisor = BigInt(clean.length);
  const base = outputValueSat / divisor;
  let remainder = outputValueSat % divisor;

  return clean.map((address) => {
    const extra = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder -= 1n;
    return { address, amountSat: base + extra };
  });
}

function edgeKey(source: string, target: string): string {
  return `${source}->${target}`;
}

function computeTxWeight(totalOutputSat: bigint, involvedCount: number): number {
  const coinAmount = satToCoin(totalOutputSat);
  const valueScore = Math.log10(Math.max(1, coinAmount + 1));
  return 1 + valueScore + Math.min(4, involvedCount / 6);
}

function toSortedParent(parentScores: Map<string, number>, fallback: string): string {
  let bestParent = fallback;
  let bestScore = -1;
  for (const [candidate, score] of parentScores) {
    if (score > bestScore) {
      bestScore = score;
      bestParent = candidate;
    }
  }
  return bestParent;
}

async function buildAddressGraph(
  rootAddress: string,
  depth: number,
  maxNodes: number,
  maxEdges: number
): Promise<{ nodes: GraphNodeResult[]; edges: GraphEdgeResult[] }> {
  const visited = new Set<string>([rootAddress]);
  const depthByAddress = new Map<string, number>([[rootAddress, 0]]);
  const firstHopByAddress = new Map<string, string>([[rootAddress, rootAddress]]);

  let frontier = new Set<string>([rootAddress]);
  const edgeMap = new Map<string, EdgeAccumulator>();
  const useInvolved = await graphHasInvolvedField();

  for (let level = 0; level < depth; level += 1) {
    if (frontier.size === 0 || visited.size >= maxNodes) break;

    const frontierAddresses = Array.from(frontier);
    const frontierSet = new Set(frontierAddresses);
    const levelTxLimit = Math.min(1600, Math.max(300, frontierAddresses.length * 220));

    let txQuery = buildFrontierTxQuery(frontierAddresses, useInvolved);
    let txs = await Transaction.find(txQuery)
      .sort({ blockheight: -1, _id: -1 })
      .limit(levelTxLimit)
      .select({
        txid: 1,
        blocktime: 1,
        involvedAddresses: 1,
        vin: 1,
        vout: 1,
      })
      .lean<GraphTxLean[]>();

    // Fallback: if involvedAddresses query returned nothing, retry with vin/vout fields.
    // This handles DBs where involvedAddresses is not yet populated for all transactions.
    if (txs.length === 0 && useInvolved) {
      const legacyQuery = buildFrontierTxQuery(frontierAddresses, false);
      txs = await Transaction.find(legacyQuery)
        .sort({ blockheight: -1, _id: -1 })
        .limit(levelTxLimit)
        .select({
          txid: 1,
          blocktime: 1,
          involvedAddresses: 1,
          vin: 1,
          vout: 1,
        })
        .lean<GraphTxLean[]>();
    }

    const candidates = new Map<string, CandidateScore>();

    for (const tx of txs) {
      const inputByAddress = new Map<string, bigint>();
      const outputByAddress = new Map<string, bigint>();

      for (const vin of tx.vin || []) {
        if (!isGraphAddressCandidate(vin.address)) continue;
        addToBigIntMap(inputByAddress, vin.address, satToBigInt(vin.valueSat));
      }

      for (const vout of tx.vout || []) {
        const allocated = allocateOutputToAddresses(
          satToBigInt(vout.valueSat),
          vout.scriptPubKey?.addresses || []
        );
        for (const output of allocated) {
          addToBigIntMap(outputByAddress, output.address, output.amountSat);
        }
      }

      const involved = new Set<string>();
      for (const addr of tx.involvedAddresses || []) {
        if (isGraphAddressCandidate(addr)) involved.add(addr);
      }
      for (const addr of inputByAddress.keys()) involved.add(addr);
      for (const addr of outputByAddress.keys()) involved.add(addr);
      if (involved.size === 0) continue;

      const frontierMembers = frontierAddresses.filter((address) => involved.has(address));
      if (frontierMembers.length === 0) continue;

      let totalOutputSat = 0n;
      for (const amount of outputByAddress.values()) totalOutputSat += amount;

      const txWeight = computeTxWeight(totalOutputSat, involved.size);

      if (totalOutputSat > 0n && inputByAddress.size > 0 && outputByAddress.size > 0) {
        for (const [source, sourceValueSat] of inputByAddress) {
          if (sourceValueSat <= 0n) continue;
          for (const [target, targetValueSat] of outputByAddress) {
            if (source === target || targetValueSat <= 0n) continue;
            const weightedAmountSat = (sourceValueSat * targetValueSat) / totalOutputSat;
            if (weightedAmountSat <= 0n) continue;

            const key = edgeKey(source, target);
            const existing = edgeMap.get(key);
            if (existing) {
              existing.txCount += 1;
              existing.totalSat += weightedAmountSat;
              if (typeof tx.blocktime === 'number') {
                existing.lastBlocktime = Math.max(existing.lastBlocktime || 0, tx.blocktime);
              }
            } else {
              edgeMap.set(key, {
                source,
                target,
                txCount: 1,
                totalSat: weightedAmountSat,
                lastBlocktime: typeof tx.blocktime === 'number' ? tx.blocktime : null,
              });
            }
          }
        }
      }

      for (const frontierAddress of frontierMembers) {
        for (const neighbor of involved) {
          if (neighbor === frontierAddress || frontierSet.has(neighbor) || visited.has(neighbor)) continue;
          const existing = candidates.get(neighbor);
          if (!existing) {
            candidates.set(neighbor, {
              score: txWeight,
              parentScores: new Map([[frontierAddress, txWeight]]),
            });
            continue;
          }
          existing.score += txWeight;
          existing.parentScores.set(
            frontierAddress,
            (existing.parentScores.get(frontierAddress) || 0) + txWeight
          );
        }
      }
    }

    const remainingSlots = Math.max(0, maxNodes - visited.size);
    if (remainingSlots === 0) break;

    const nextFrontierEntries = Array.from(candidates.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, remainingSlots);

    const nextFrontier = new Set<string>();
    for (const [candidateAddress, candidate] of nextFrontierEntries) {
      visited.add(candidateAddress);
      nextFrontier.add(candidateAddress);
      depthByAddress.set(candidateAddress, level + 1);

      const parentFallback = frontierAddresses[0] || rootAddress;
      const parent = toSortedParent(candidate.parentScores, parentFallback);
      const parentFirstHop = firstHopByAddress.get(parent) || parent;
      firstHopByAddress.set(candidateAddress, level === 0 ? candidateAddress : parentFirstHop);
    }

    frontier = nextFrontier;
  }

  const keptAddresses = Array.from(visited);
  const keptAddressSet = new Set(keptAddresses);

  const balanceDocs = await Address.find({ address: { $in: keptAddresses } })
    .select({ address: 1, balanceSat: 1, txCount: 1 })
    .lean<Array<{ address: string; balanceSat?: SatLike; txCount?: number }>>();

  const balanceByAddress = new Map(balanceDocs.map((doc) => [doc.address, satToCoin(doc.balanceSat)]));
  const txCountByAddress = new Map(balanceDocs.map((doc) => [doc.address, doc.txCount || 0]));

  const groupByFirstHop = new Map<string, number>([[rootAddress, 0]]);
  let nextGroup = 1;

  const nodes: GraphNodeResult[] = keptAddresses
    .map((address) => {
      const firstHop = firstHopByAddress.get(address) || rootAddress;
      let group = groupByFirstHop.get(firstHop);
      if (group == null) {
        group = nextGroup;
        nextGroup += 1;
        groupByFirstHop.set(firstHop, group);
      }

      return {
        id: address,
        address,
        balance: balanceByAddress.get(address) || 0,
        txCount: txCountByAddress.get(address) || 0,
        isRoot: address === rootAddress,
        depth: depthByAddress.get(address) ?? depth,
        group,
      };
    })
    .sort((a, b) => {
      if (a.isRoot) return -1;
      if (b.isRoot) return 1;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return b.balance - a.balance;
    });

  const edges: GraphEdgeResult[] = Array.from(edgeMap.values())
    .filter((edge) => keptAddressSet.has(edge.source) && keptAddressSet.has(edge.target))
    .sort((a, b) => {
      if (a.totalSat !== b.totalSat) return a.totalSat > b.totalSat ? -1 : 1;
      return b.txCount - a.txCount;
    })
    .slice(0, maxEdges)
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      txCount: edge.txCount,
      totalAmount: satToCoin(edge.totalSat),
      lastBlocktime: edge.lastBlocktime,
    }));

  return { nodes, edges };
}

// Use $filter + $reduce instead of $unwind to avoid array explosion
function buildRewardPipeline(
  txMatch: Record<string, unknown>,
  address: string
) {
  return [
    { $match: txMatch },
    {
      $project: {
        blocktime: 1,
        matchedOutputs: {
          $filter: {
            input: '$vout',
            as: 'o',
            cond: {
              $in: [address, { $ifNull: ['$$o.scriptPubKey.addresses', []] }],
            },
          },
        },
      },
    },
    {
      $project: {
        blocktime: 1,
        outputSum: {
          $reduce: {
            input: '$matchedOutputs',
            initialValue: { $toDecimal: '0' },
            in: {
              $add: [
                '$$value',
                { $convert: { input: '$$this.valueSat', to: 'decimal', onError: { $toDecimal: '0' }, onNull: { $toDecimal: '0' } } },
              ],
            },
          },
        },
      },
    },
    {
      $group: {
        _id: null,
        totalSat: { $sum: '$outputSum' },
        count: { $sum: 1 },
        lastBlocktime: { $max: '$blocktime' },
      },
    },
  ];
}

const STAKE_CANDIDATE_PROJECTION = {
  _id: 0,
  isCoinbase: 1,
  blocktime: 1,
  'vin.address': 1,
  'vin.valueSat': 1,
  'vout.valueSat': 1,
  'vout.scriptPubKey.addresses': 1,
  'vout.scriptPubKey.hex': 1,
};

type StakeCandidate = Omit<RoleTx, 'vin'> & {
  blocktime?: number;
  vin?: Array<{ address?: unknown; valueSat?: unknown } | null | undefined> | null;
};

/**
 * The stakes an address made and their net reward. A stake is a transaction in which the address
 * is the staker by `stakerOf`, the same rule the block page uses; its reward is what came back to
 * the address minus what it put in. A stake whose amounts are not all stored as whole satoshis is
 * counted but adds nothing to the total, rather than a guessed amount.
 *
 * The candidates are the address's own spends that are not coinbases (indexed by `vin.address`),
 * read one batch at a time; their number grows with the address's activity.
 */
async function loadStakeRewards(address: string) {
  let count = 0;
  let netSat = 0n;
  let lastBlocktime: number | null = null;
  const cursor = Transaction.find({ isCoinbase: false, 'vin.address': address })
    .select(STAKE_CANDIDATE_PROJECTION)
    .lean<StakeCandidate[]>()
    .cursor({ batchSize: 500 });

  for await (const doc of cursor) {
    const tx = doc as unknown as StakeCandidate;
    if (stakerOf(tx as RoleTx) !== address) continue;
    count += 1;
    if (typeof tx.blocktime === 'number' && (lastBlocktime == null || tx.blocktime > lastBlocktime)) {
      lastBlocktime = tx.blocktime;
    }

    // stakerOf has checked that every input is the address's own.
    let staked: bigint | null = 0n;
    for (const input of tx.vin ?? []) {
      const value = exactSat(input?.valueSat);
      staked = staked != null && value != null ? staked + value : null;
    }
    let returned: bigint | null = 0n;
    for (const output of tx.vout ?? []) {
      const addresses = output?.scriptPubKey?.addresses;
      if (!Array.isArray(addresses) || addresses.length !== 1 || addresses[0] !== address) continue;
      const value = exactSat(output?.valueSat);
      returned = returned != null && value != null ? returned + value : null;
    }
    if (staked != null && returned != null) netSat += returned - staked;
  }

  return { count, netSat, lastBlocktime };
}

router.get('/:address/rewards', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const paramParsed = addressParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paramParsed.error));
    }
    const { address } = paramParsed.data;
    const cacheKey = address;

    const cached = getRewardsCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const staleCached = getRewardsStaleCache(cacheKey);
    const inFlight = rewardsInFlight.get(cacheKey);
    if (inFlight) {
      try {
        const dedupedPayload = await inFlight;
        return res.json(dedupedPayload);
      } catch {
        if (staleCached) {
          return res.json(staleCached);
        }
        throw new Error('address rewards in-flight query failed');
      }
    }

    const fetchPromise = (async (): Promise<RewardsResponsePayload> => {
      const [coinbaseAgg, stakes] = await Promise.all([
        Transaction.aggregate<AggResult>(
          buildRewardPipeline(
            { isCoinbase: true, 'vout.scriptPubKey.addresses': address },
            address
          )
        ),
        loadStakeRewards(address),
      ]);

      const cb = coinbaseAgg[0];
      const payload: RewardsResponsePayload = {
        success: true,
        data: {
          address,
          coinbaseTxCount: cb?.count ?? 0,
          coinbaseTotal: satToCoin(cb?.totalSat ?? 0),
          lastCoinbaseAt: cb?.lastBlocktime ?? null,
          stakeTxCount: stakes.count,
          stakeTotal: satToCoin(stakes.netSat),
          lastStakeAt: stakes.lastBlocktime,
        },
      };
      setRewardsCache(cacheKey, payload);
      return payload;
    })();

    rewardsInFlight.set(cacheKey, fetchPromise);
    try {
      const payload = await fetchPromise;
      return res.json(payload);
    } catch (error) {
      if (staleCached) {
        return res.json(staleCached);
      }
      throw error;
    } finally {
      if (rewardsInFlight.get(cacheKey) === fetchPromise) {
        rewardsInFlight.delete(cacheKey);
      }
    }
  } catch (error) {
    sendInternalError(res, 'Failed to fetch address rewards', error);
  }
});

router.get('/:address/graph', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const paramParsed = addressParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paramParsed.error));
    }

    const queryParsed = graphQuerySchema.safeParse({
      depth: req.query.depth,
      maxNodes: req.query.maxNodes,
      maxEdges: req.query.maxEdges,
    });
    if (!queryParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(queryParsed.error));
    }

    const { address } = paramParsed.data;
    const { depth, maxNodes, maxEdges } = queryParsed.data;
    const cacheKey = `${address}:${depth}:${maxNodes}:${maxEdges}`;

    const cached = getGraphCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const staleCached = getGraphStaleCache(cacheKey);

    const pending = graphInFlight.get(cacheKey);
    if (pending) {
      try {
        const payload = await pending;
        return res.json(payload);
      } catch {
        if (staleCached) {
          return res.json(staleCached);
        }
        throw new Error('address graph in-flight query failed');
      }
    }

    const buildPromise = (async (): Promise<GraphResponsePayload> => {
      const { nodes, edges } = await buildAddressGraph(address, depth, maxNodes, maxEdges);

      return {
        success: true,
        data: {
          address,
          depth,
          maxNodes,
          maxEdges,
          nodeCount: nodes.length,
          edgeCount: edges.length,
          nodes,
          edges,
        },
      };
    })();
    graphInFlight.set(cacheKey, buildPromise);

    try {
      const payload = await buildPromise;
      setGraphCache(cacheKey, payload);
      return res.json(payload);
    } catch (error) {
      if (staleCached) {
        return res.json(staleCached);
      }
      throw error;
    } finally {
      if (graphInFlight.get(cacheKey) === buildPromise) {
        graphInFlight.delete(cacheKey);
      }
    }
  } catch (error) {
    return sendInternalError(res, 'Failed to fetch address graph', error);
  }
});

export default router;
