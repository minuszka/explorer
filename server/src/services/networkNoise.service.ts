import crypto from 'node:crypto';
import type { NetworkNoiseIngestPayload } from '@defcon/shared/dist/contracts';
import { config } from '../config';
import { NetworkNoiseNodeState } from '../models/NetworkNoiseNodeState';
import { NetworkNoiseObservation } from '../models/NetworkNoiseObservation';
import { logger } from '../utils/logger';
import { isDuplicateKeyOnly } from '../domain/pose/poseTelemetry';
import { poseTelemetryService } from './poseTelemetry.service';
import { networkNoiseBatchService } from './networkNoiseBatch.service';

export type NetworkNoiseRole = 'seed' | 'fullnode' | 'test_mn' | 'masternode' | 'unknown';

export type NetworkNoiseSignalInput = {
  type: string;
  fingerprint: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  peerIps?: string[];
  sample?: string | null;
};

export type NetworkNoisePayload = NetworkNoiseIngestPayload;

const SIGNAL_WEIGHTS: Record<string, number> = {
  chainlock_conflict: 18,
  chain_tip_divergence: 25,
  reorg_attempt: 20,
  llmq_quorum: 15,
  pose_instability: 12,
  stale_peer: 5,
  peer_churn: 4,
  peer_rejection: 6,
  sync_stall: 18,
  rpc_unavailable: 18,
  clock_drift: 15,
  resource_pressure: 8,
};

const CHAIN_SIGNAL_TYPES = new Set([
  'chainlock_conflict',
  'chain_tip_divergence',
  'reorg_attempt',
]);

function calculateNoiseScore(signals: NetworkNoiseSignalInput[]): number {
  const score = signals.reduce((total, signal) => {
    const weight = SIGNAL_WEIGHTS[signal.type] ?? 3;
    const frequencyMultiplier = Math.min(5, Math.max(1, signal.count));
    return total + weight * frequencyMultiplier;
  }, 0);
  return Math.min(100, score);
}

function makeDedupeKey(payload: NetworkNoisePayload, signal: NetworkNoiseSignalInput): string {
  return crypto
    .createHash('sha256')
    .update(`${payload.nodeId}:${payload.sequence}:${signal.type}:${signal.fingerprint}`)
    .digest('hex');
}

function noiseLevel(score: number): 'quiet' | 'elevated' | 'noisy' | 'severe' | 'critical' {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'severe';
  if (score >= 35) return 'noisy';
  if (score >= 15) return 'elevated';
  return 'quiet';
}

class NetworkNoiseService {
  async ingest(payload: NetworkNoisePayload): Promise<{
    duplicate: boolean;
    acceptedSignals: number;
    noiseScore: number;
    acceptedPoseObservations?: number;
  }> {
    const receivedAt = new Date();
    const batch = await networkNoiseBatchService.claim(payload, receivedAt);
    if (batch.status === 'duplicate') {
      return {
        duplicate: true,
        acceptedSignals: 0,
        noiseScore: 0,
        ...(payload.schemaVersion === 2 ? { acceptedPoseObservations: 0 } : {}),
      };
    }

    const observedAt = new Date(payload.observedAt);
    // Check agent times against the limit stored with the batch's receipt (first
    // arrival plus a bounded clock-skew allowance), never against a retry.
    const timeLimit = batch.timeLimit;
    const timeVerified = (value: string) => new Date(value).getTime() <= timeLimit;
    const reportTimeVerified = timeVerified(payload.observedAt);
    const signalTimingInvalid = payload.signals.some((signal) =>
      !timeVerified(signal.firstSeenAt) || !timeVerified(signal.lastSeenAt)
    );
    const signalIntervalVerified = payload.signals.every((signal) =>
      new Date(signal.firstSeenAt) <= new Date(signal.lastSeenAt)
    );
    const expiresAt = new Date(
      observedAt.getTime() + config.networkNoise.observationTtlDays * 24 * 60 * 60 * 1000
    );
    const noiseScore = calculateNoiseScore(payload.signals);
    const signalCount = payload.signals.reduce((total, signal) => total + signal.count, 0);
    const activeSignalTypes = Array.from(new Set(payload.signals.map((signal) => signal.type))).sort();

    if (payload.signals.length > 0) {
      const operations = payload.signals.map((signal) => {
        const dedupeKey = makeDedupeKey(payload, signal);
        const verified = reportTimeVerified && timeVerified(signal.firstSeenAt) && timeVerified(signal.lastSeenAt);
        const firstSeenAt = new Date(signal.firstSeenAt);
        const lastSeenAt = new Date(signal.lastSeenAt);
        const peerIps = Array.from(new Set(signal.peerIps ?? [])).slice(0, 20);
        const fixed = {
          dedupeKey,
          nodeId: payload.nodeId,
          nodeRole: payload.nodeRole,
          ip: payload.snapshot.ip,
          walletVersion: payload.snapshot.walletVersion ?? null,
          sequence: payload.sequence,
          observedAt,
          receivedAt: batch.firstReceivedAt,
          signalType: signal.type,
          fingerprint: signal.fingerprint,
          sample: signal.sample?.slice(0, 300) ?? null,
          blockHeight: payload.snapshot.blockHeight ?? null,
          bestBlockHash: payload.snapshot.bestBlockHash ?? null,
          chainLockHeight: payload.snapshot.chainLockHeight ?? null,
          chainLockHash: payload.snapshot.chainLockHash ?? null,
          expiresAt,
        };
        // A resend re-reads the log from the same position, so it covers what an
        // earlier attempt stored under this key. Merging keeps what that attempt
        // counted, and a row that failed its time check stays unverified.
        const update = batch.resend
          ? { $setOnInsert: fixed, $set: { peerIps }, $max: { count: signal.count, lastSeenAt },
            $min: { firstSeenAt, timeVerified: verified } }
          : { $setOnInsert: { ...fixed, timeVerified: verified, count: signal.count, firstSeenAt, lastSeenAt, peerIps } };
        return { updateOne: { filter: { dedupeKey }, update, upsert: true } };
      });

      try {
        await NetworkNoiseObservation.bulkWrite(operations, { ordered: false });
      } catch (error) {
        // Concurrent retries can race on the unique dedupe key. The state
        // update below is still safe, and duplicate observations are ignored.
        if (!isDuplicateKeyOnly(error)) throw error;
      }
    }

    // Complete both stores before advancing the sequence. A failed PoSe write
    // remains retryable; all already written observations have stable keys.
    const acceptedPoseObservations = payload.schemaVersion === 2
      ? await poseTelemetryService.ingest(payload, batch.firstReceivedAt, batch.timeLimit) : undefined;

    const stateUpdate: Record<string, unknown> = {
      nodeRole: payload.nodeRole,
      ip: payload.snapshot.ip,
      walletVersion: payload.snapshot.walletVersion ?? null,
      agentVersion: payload.agentVersion,
      lastSequence: payload.sequence,
      lastReportedAt: observedAt,
      reportTimeVerified,
      blockHeight: payload.snapshot.blockHeight ?? null,
      bestBlockHash: payload.snapshot.bestBlockHash ?? null,
      chainLockHeight: payload.snapshot.chainLockHeight ?? null,
      chainLockHash: payload.snapshot.chainLockHash ?? null,
      connections: payload.snapshot.connections ?? null,
      inbound: payload.snapshot.inbound ?? null,
      outbound: payload.snapshot.outbound ?? null,
      syncing: payload.snapshot.syncing ?? null,
      noiseScore,
      signalCount,
      signalTimingInvalid,
      signalIntervalVerified,
      activeSignalTypes,
    };
    if (payload.signals.length === 0 && (payload.schemaVersion === 1 || payload.poseEvents.length === 0)) {
      stateUpdate.lastCleanAt = observedAt;
    }

    // A concurrent newer batch may have committed after the initial read.
    // Ensure the unique node key exists before relying on the upsert race guard.
    // A retry rewrites the snapshot of its own sequence with the same verdict (or
    // an unverified one for an earlier version's receipt); a newer one is kept.
    // Rows an earlier version wrote without a check are not re-judged. Within one
    // sequence an older report time loses, so a stalled attempt cannot overwrite
    // the resend that replaced it.
    await NetworkNoiseNodeState.init();
    const stateFilter = { nodeId: payload.nodeId, $or: [
      { lastSequence: { $lt: payload.sequence } },
      { lastSequence: payload.sequence, lastReportedAt: { $lte: observedAt } },
    ] };
    try {
      await NetworkNoiseNodeState.updateOne(stateFilter, {
        $set: stateUpdate,
        $setOnInsert: { nodeId: payload.nodeId },
      }, { upsert: true });
    } catch (error) {
      if (!isDuplicateKeyOnly(error)) throw error;
      // Another writer inserted the node, or an equal/newer sequence already
      // exists. Retry without upsert so only an older state can be updated.
      await NetworkNoiseNodeState.updateOne(stateFilter, { $set: stateUpdate });
    }

    await networkNoiseBatchService.complete(payload);
    return {
      duplicate: false,
      acceptedSignals: payload.signals.length,
      noiseScore,
      ...(acceptedPoseObservations !== undefined ? { acceptedPoseObservations } : {}),
    };
  }

  async getSummary(hours = 24) {
    const now = new Date();
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const staleCutoff = new Date(now.getTime() - config.networkNoise.staleAfterMs);
    // Rows stored before the receipt-time check have no flag and keep the
    // previous time rule until they expire.
    const validSignalWindow = { firstSeenAt: { $lte: now }, lastSeenAt: { $gte: from, $lte: now },
      observedAt: { $lte: now }, expiresAt: { $gt: now }, timeVerified: { $ne: false },
      $expr: { $lte: ['$firstSeenAt', '$lastSeenAt'] } };

    const [states, timelineRows, recentSignals] = await Promise.all([
      NetworkNoiseNodeState.find({})
        .sort({ noiseScore: -1, lastReportedAt: -1 })
        .lean(),
      NetworkNoiseObservation.aggregate<{
        bucket: string;
        signalType: string;
        count: number;
        nodes: string[];
      }>([
        { $match: validSignalWindow },
        {
          $group: {
            _id: {
              bucket: {
                $dateToString: {
                  date: '$lastSeenAt',
                  format: '%Y-%m-%dT%H:00:00.000Z',
                  timezone: 'UTC',
                },
              },
              signalType: '$signalType',
            },
            count: { $sum: '$count' },
            nodes: { $addToSet: '$nodeId' },
          },
        },
        {
          $project: {
            _id: 0,
            bucket: '$_id.bucket',
            signalType: '$_id.signalType',
            count: 1,
            nodes: 1,
          },
        },
        { $sort: { bucket: 1, signalType: 1 } },
      ]),
      NetworkNoiseObservation.find(validSignalWindow)
        .sort({ lastSeenAt: -1 })
        .limit(80)
        .select({
          _id: 0,
          nodeId: 1,
          nodeRole: 1,
          walletVersion: 1,
          signalType: 1,
          fingerprint: 1,
          count: 1,
          firstSeenAt: 1,
          lastSeenAt: 1,
          sample: 1,
          blockHeight: 1,
          bestBlockHash: 1,
          chainLockHeight: 1,
          chainLockHash: 1,
        })
        .lean(),
    ]);

    const isFresh = (state: typeof states[number]) => state.lastReportedAt >= staleCutoff && state.lastReportedAt <= now
      && state.reportTimeVerified === true
      && (state.signalTimingInvalid === false || (state.signalTimingInvalid === undefined && state.signalCount === 0))
      && (state.signalIntervalVerified === true || (state.signalIntervalVerified === undefined && state.signalCount === 0));
    const reporting = states.filter(isFresh);
    const currentScore = reporting.reduce((max, state) => Math.max(max, state.noiseScore), 0);
    const activeSignals = reporting.reduce((total, state) => total + state.signalCount, 0);
    const chainAlerts = reporting.filter((state) =>
      state.activeSignalTypes.some((type) => CHAIN_SIGNAL_TYPES.has(type))
    ).length;

    return {
      generatedAt: now.toISOString(),
      windowHours: hours,
      staleAfterSeconds: Math.floor(config.networkNoise.staleAfterMs / 1000),
      summary: {
        currentScore,
        currentLevel: noiseLevel(currentScore),
        knownNodes: states.length,
        reportingNodes: reporting.length,
        staleNodes: states.length - reporting.length,
        activeSignals,
        chainAlerts,
      },
      // The summary is public: reported node IPs and peer IPs are stored but
      // never included here.
      nodes: states.map((state) => ({
        nodeId: state.nodeId,
        nodeRole: state.nodeRole,
        walletVersion: state.walletVersion,
        agentVersion: state.agentVersion,
        lastReportedAt: state.lastReportedAt.toISOString(),
        blockHeight: state.blockHeight,
        bestBlockHash: state.bestBlockHash,
        chainLockHeight: state.chainLockHeight,
        chainLockHash: state.chainLockHash,
        connections: state.connections,
        inbound: state.inbound,
        outbound: state.outbound,
        syncing: state.syncing,
        noiseScore: state.noiseScore,
        signalCount: state.signalCount,
        activeSignalTypes: state.activeSignalTypes,
        lastCleanAt: state.lastCleanAt?.toISOString() ?? null,
        isStale: !isFresh(state),
      })),
      timeline: timelineRows,
      recentSignals: recentSignals.map((row) => ({
        ...row,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      })),
    };
  }
}

export const networkNoiseService = new NetworkNoiseService();

export function logNetworkNoiseIngestFailure(error: unknown): void {
  logger.warn('Network noise ingest failed', error);
}
