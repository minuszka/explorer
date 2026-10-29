import crypto from 'node:crypto';
import type { NetworkNoiseIngestPayload } from '@defcon/shared/dist/contracts';
import { config } from '../config';
import { NetworkNoiseNodeState } from '../models/NetworkNoiseNodeState';
import { NetworkNoiseObservation } from '../models/NetworkNoiseObservation';
import { logger } from '../utils/logger';
import { isDuplicateKeyOnly } from '../domain/pose/poseTelemetry';
import { poseTelemetryService } from './poseTelemetry.service';

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
    const current = await NetworkNoiseNodeState.findOne({ nodeId: payload.nodeId })
      .select({ lastSequence: 1 })
      .lean();

    if (current && payload.sequence <= current.lastSequence) {
      return {
        duplicate: true,
        acceptedSignals: 0,
        noiseScore: 0,
        ...(payload.schemaVersion === 2 ? { acceptedPoseObservations: 0 } : {}),
      };
    }

    const observedAt = new Date(payload.observedAt);
    const expiresAt = new Date(
      observedAt.getTime() + config.networkNoise.observationTtlDays * 24 * 60 * 60 * 1000
    );
    const noiseScore = calculateNoiseScore(payload.signals);
    const signalCount = payload.signals.reduce((total, signal) => total + signal.count, 0);
    const activeSignalTypes = Array.from(new Set(payload.signals.map((signal) => signal.type))).sort();

    if (payload.signals.length > 0) {
      const operations = payload.signals.map((signal) => ({
        updateOne: {
          filter: { dedupeKey: makeDedupeKey(payload, signal) },
          update: {
            $setOnInsert: {
              dedupeKey: makeDedupeKey(payload, signal),
              nodeId: payload.nodeId,
              nodeRole: payload.nodeRole,
              ip: payload.snapshot.ip,
              walletVersion: payload.snapshot.walletVersion ?? null,
              sequence: payload.sequence,
              observedAt,
              signalType: signal.type,
              fingerprint: signal.fingerprint,
              count: signal.count,
              firstSeenAt: new Date(signal.firstSeenAt),
              lastSeenAt: new Date(signal.lastSeenAt),
              peerIps: Array.from(new Set(signal.peerIps ?? [])).slice(0, 20),
              sample: signal.sample?.slice(0, 300) ?? null,
              blockHeight: payload.snapshot.blockHeight ?? null,
              bestBlockHash: payload.snapshot.bestBlockHash ?? null,
              chainLockHeight: payload.snapshot.chainLockHeight ?? null,
              chainLockHash: payload.snapshot.chainLockHash ?? null,
              expiresAt,
            },
          },
          upsert: true,
        },
      }));

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
      ? await poseTelemetryService.ingest(payload) : undefined;

    const stateUpdate: Record<string, unknown> = {
      nodeRole: payload.nodeRole,
      ip: payload.snapshot.ip,
      walletVersion: payload.snapshot.walletVersion ?? null,
      agentVersion: payload.agentVersion,
      lastSequence: payload.sequence,
      lastReportedAt: observedAt,
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
      activeSignalTypes,
    };
    if (payload.signals.length === 0 && (payload.schemaVersion === 1 || payload.poseEvents.length === 0)) {
      stateUpdate.lastCleanAt = observedAt;
    }

    // A concurrent newer batch may have committed after the initial read.
    // Ensure the unique node key exists before relying on the upsert race guard.
    await NetworkNoiseNodeState.init();
    const stateFilter = { nodeId: payload.nodeId, lastSequence: { $lt: payload.sequence } };
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
    const validSignalWindow = { lastSeenAt: { $gte: from, $lte: now }, observedAt: { $lte: now }, expiresAt: { $gt: now } };

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

    const isFresh = (reportedAt: Date) => reportedAt >= staleCutoff && reportedAt <= now;
    const reporting = states.filter((state) => isFresh(state.lastReportedAt));
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
        isStale: !isFresh(state.lastReportedAt),
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
