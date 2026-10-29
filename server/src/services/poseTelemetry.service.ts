import type { PipelineStage } from 'mongoose';
import type { NetworkNoiseIngestPayload, PoseEventsQuery, PoseObservedEventsContract } from '@defcon/shared/dist/contracts';
import { config } from '../config';
import { isDuplicateKeyOnly, poseObservationIdentity } from '../domain/pose/poseTelemetry';
import { PoseObservation } from '../models/PoseObservation';

class PoseTelemetryService {
  async ingest(payload: Extract<NetworkNoiseIngestPayload, { schemaVersion: 2 }>): Promise<number> {
    if (payload.poseEvents.length === 0) return 0;
    // Wait for the unique key index before serving the first concurrent batch.
    await PoseObservation.init();
    const receivedAt = new Date();
    // Retain delayed log uploads for a full retention interval after arrival.
    const expiresAt = new Date(receivedAt.getTime() + config.networkNoise.poseObservationTtlDays * 86400000);
    const operations = payload.poseEvents.map((event) => {
      const identity = poseObservationIdentity(payload.nodeId, event);
      return { updateOne: {
        filter: { observationKey: identity.observationKey },
        update: { $setOnInsert: {
          ...identity,
          ...event,
          sample: event.sample ?? null,
          eventAt: new Date(event.eventAt),
          observedAt: new Date(payload.observedAt),
          receivedAt,
          expiresAt,
          nodeId: payload.nodeId,
          nodeRole: payload.nodeRole,
          agentVersion: payload.agentVersion,
          schemaVersion: 2,
          walletVersion: payload.snapshot.walletVersion ?? null,
          sequence: payload.sequence,
          snapshotBlockHeight: payload.snapshot.blockHeight ?? null,
          snapshotBlockHash: payload.snapshot.bestBlockHash ?? null,
        } },
        upsert: true,
      } };
    });
    try {
      const result = await PoseObservation.bulkWrite(operations, { ordered: false });
      return result.upsertedCount;
    } catch (error) {
      if (!isDuplicateKeyOnly(error)) throw error;
      return (error as { result?: { upsertedCount?: number } }).result?.upsertedCount ?? 0;
    }
  }

  async getEvents(query: PoseEventsQuery): Promise<PoseObservedEventsContract> {
    const now = new Date();
    const match: Record<string, unknown> = {
      eventAt: { $gte: new Date(now.getTime() - query.hours * 3600000), $lte: now },
      observedAt: { $lte: now },
      expiresAt: { $gt: now },
    };
    if (query.kind !== undefined) match.kind = query.kind;
    if (query.quorumType !== undefined) match.quorumType = query.quorumType;
    if (query.proTxHash !== undefined) match.proTxHash = query.proTxHash;
    if (query.eventBlockHeight !== undefined) match.eventBlockHeight = query.eventBlockHeight;
    if (query.eventBlockHash !== undefined) match.eventBlockHash = query.eventBlockHash;
    if (query.quorumHash !== undefined) match.quorumHash = query.quorumHash;
    const pipeline: PipelineStage[] = [
      { $match: match },
      { $sort: { eventAt: 1, observationKey: 1 } },
      { $group: {
        _id: '$eventKey',
        kind: { $first: '$kind' },
        identityComplete: { $first: '$identityComplete' },
        eventBlockHeight: { $first: '$eventBlockHeight' },
        eventBlockHash: { $first: '$eventBlockHash' },
        quorumType: { $first: '$quorumType' },
        quorumHash: { $first: '$quorumHash' },
        proTxHash: { $first: '$proTxHash' },
        firstEventAt: { $min: '$eventAt' },
        lastEventAt: { $max: '$eventAt' },
        lastReportedAt: { $max: '$observedAt' },
        observerNodeIds: { $addToSet: '$nodeId' },
        observerRoles: { $addToSet: '$nodeRole' },
        observationCount: { $sum: 1 },
        scoreVariants: { $addToSet: {
          previousPenalty: '$previousPenalty', penalty: '$penalty',
          poseBanHeight: '$poseBanHeight', memberValid: '$memberValid',
        } },
        sample: { $first: '$sample' },
      } },
      { $facet: {
        totals: [{ $group: {
          _id: null,
          total: { $sum: 1 },
          observationCount: { $sum: '$observationCount' },
          uncorrelatedEvents: { $sum: { $cond: ['$identityComplete', 0, 1] } },
        } }],
        events: [
          { $sort: { lastEventAt: -1, _id: 1 } },
          { $skip: (query.page - 1) * query.limit },
          { $limit: query.limit },
          { $project: {
            _id: 0, eventKey: '$_id', kind: 1, identityComplete: 1,
            evidence: { $literal: 'log_observed' }, canonicalStatus: { $literal: 'unverified' },
            eventBlockHeight: 1, eventBlockHash: 1, quorumType: 1, quorumHash: 1, proTxHash: 1,
            firstEventAt: 1, lastEventAt: 1, lastReportedAt: 1,
            observerCount: { $size: '$observerNodeIds' }, observerNodeIds: 1, observerRoles: 1,
            observationCount: 1, scoreVariants: 1,
            hasConflictingScores: { $gt: [{ $size: '$scoreVariants' }, 1] }, sample: 1,
          } },
        ],
      } },
    ];
    type EventRow = Omit<PoseObservedEventsContract['events'][number], 'firstEventAt' | 'lastEventAt' | 'lastReportedAt'>
      & { firstEventAt: Date; lastEventAt: Date; lastReportedAt: Date };
    const [result] = await PoseObservation.aggregate<{
      totals: { total: number; observationCount: number; uncorrelatedEvents: number }[];
      events: EventRow[];
    }>(pipeline).option({ maxTimeMS: 10000 });
    const totals = result?.totals[0] ?? { total: 0, observationCount: 0, uncorrelatedEvents: 0 };
    return {
      generatedAt: now.toISOString(), windowHours: query.hours,
      retentionDays: config.networkNoise.poseObservationTtlDays,
      page: query.page, limit: query.limit,
      total: totals.total, observationCount: totals.observationCount,
      uncorrelatedEvents: totals.uncorrelatedEvents, chainVerifiedEvents: 0,
      events: (result?.events ?? []).map((event) => ({
        ...event,
        firstEventAt: event.firstEventAt.toISOString(),
        lastEventAt: event.lastEventAt.toISOString(),
        lastReportedAt: event.lastReportedAt.toISOString(),
        observerNodeIds: event.observerNodeIds.sort(),
        observerRoles: event.observerRoles.sort(),
      })),
    };
  }
}

export const poseTelemetryService = new PoseTelemetryService();
