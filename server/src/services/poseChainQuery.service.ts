import type { PipelineStage } from 'mongoose';
import type { PoseChainData, PoseChainQuery } from '@defcon/shared/dist/contracts';
import { config } from '../config';
import { PoseChainBlock } from '../models/PoseChainBlock';
import { PoseChainState, type PoseChainStateDocument } from '../models/PoseChainState';
import { PoseObservation } from '../models/PoseObservation';
import type { PenaltyAttribution } from '../domain/pose/penaltyAttribution';

function collectorStatus(state: PoseChainStateDocument | null, now: Date): PoseChainData['status'] {
  if (!config.poseChain.enabled) return 'disabled';
  if (!state || state.status === 'error') return 'unavailable';
  if (state.status !== 'ready') return 'collecting';
  const age = state.checkedAt ? now.getTime() - state.checkedAt.getTime() : Infinity;
  return !Number.isFinite(age) || age < 0 || age > Math.max(180000, config.poseChain.intervalMs * 3) ? 'stale' : 'ready';
}

export async function getPoseChainData(query: PoseChainQuery): Promise<PoseChainData> {
  const now = new Date();
  const windowFrom = new Date(Math.max(now.getTime() - query.hours * 3600000,
    query.since ? Date.parse(query.since) : 0));
  const state = await PoseChainState.findOne({ key: 'main' }).lean();
  const status = collectorStatus(state, now);
  const attributionEnabled = config.poseChain.attributionEnabled;
  const data: PoseChainData = {
    generatedAt: now.toISOString(), status,
    coverage: {
      startHeight: state?.startHeight ?? config.poseChain.startHeight,
      lastHeight: state?.lastHeight ?? config.poseChain.startHeight - 1,
      lastHash: state?.lastHash ?? null, targetHeight: state?.targetHeight ?? null,
      checkedAt: state?.checkedAt?.toISOString() ?? null, lastReorgAt: state?.lastReorgAt?.toISOString() ?? null,
      remainingBlocks: state?.targetHeight == null ? null : Math.max(0, state.targetHeight - state.lastHeight),
      caughtUp: status === 'ready' && state?.targetHeight != null && state.lastHeight >= state.targetHeight,
      confirmedThroughHeight: state?.targetHeight == null ? config.poseChain.startHeight - 1
        : Math.max(state.startHeight - 1, Math.min(state.lastHeight, state.targetHeight)),
    },
    windowHours: query.hours, windowFrom: windowFrom.toISOString(), page: query.page, limit: query.limit, total: 0, quorumSummary: [], commitments: [],
    penaltyCoverage: { enabled: config.poseChain.attributionEnabled, commitmentBlocks: 0, verifiedBlocks: 0,
      pendingBlocks: 0, unavailableBlocks: 0, unsupportedBlocks: 0, inconsistentBlocks: 0, notApplicableBlocks: 0 },
  };
  // Never publish trusted attribution during rollback, failed validation, or stale checks.
  if (status !== 'ready' || !state) return data;
  const range = { canonical: true,
    height: { $gte: Math.max(state.startHeight, query.fromHeight ?? 0), $lte: data.coverage.confirmedThroughHeight },
    time: { $gte: windowFrom, $lte: now } };
  const filters: Record<string, unknown> = {};
  if (query.quorumType !== undefined) filters['commitments.quorumType'] = query.quorumType;
  if (query.proTxHash !== undefined) filters['commitments.members.proTxHash'] = query.proTxHash;
  const penaltyVerified = { $and: [{ $literal: config.poseChain.attributionEnabled },
    { $eq: ['$penaltyAttribution.status', 'verified'] }] };
  const applications = (bansOnly: boolean) => ({ $filter: {
    input: { $ifNull: ['$penaltyAttribution.applications', []] }, as: 'application',
    cond: { $and: [penaltyVerified, { $eq: ['$$application.txid', '$commitments.txid'] },
      ...(bansOnly ? [{ $eq: ['$$application.causedBan', true] }] : [])] },
  } });
  const pipeline: PipelineStage[] = [
    { $match: range },
    { $unwind: '$commitments' },
    { $match: filters },
    { $facet: {
      totals: [{ $count: 'total' }],
      summary: [{ $group: {
        _id: '$commitments.quorumType', commitments: { $sum: 1 },
        verifiedCommitments: { $sum: { $cond: [{ $eq: ['$commitments.status', 'verified'] }, 1, 0] } },
        unavailableCommitments: { $sum: { $cond: [{ $in: ['$commitments.status', ['membership_unavailable', 'unsupported_payload']] }, 1, 0] } },
        nullCommitments: { $sum: { $cond: [{ $eq: ['$commitments.status', 'null'] }, 1, 0] } },
        participants: { $sum: { $size: '$commitments.members' } },
        invalidMembers: { $sum: { $size: { $filter: { input: '$commitments.members', as: 'member', cond: { $eq: ['$$member.valid', false] } } } } },
        penaltyApplications: { $sum: { $size: applications(false) } },
        newBans: { $sum: { $size: applications(true) } },
        unknownPenaltyCommitments: { $sum: { $cond: [{ $or: [penaltyVerified,
          { $eq: ['$commitments.status', 'null'] }] }, 0, 1] } },
      } }, { $project: { _id: 0, quorumType: '$_id', commitments: 1, verifiedCommitments: 1,
        unavailableCommitments: 1, nullCommitments: 1, participants: 1, invalidMembers: 1,
        penaltyApplications: 1, newBans: 1, unknownPenaltyCommitments: 1 } },
      { $sort: { quorumType: 1 } }],
      rows: [{ $sort: { height: -1, 'commitments.txid': 1 } },
        { $skip: (query.page - 1) * query.limit }, { $limit: query.limit },
        { $project: { _id: 0, height: 1, hash: 1, time: 1, commitments: 1,
          'penaltyAttribution.status': 1, 'penaltyAttribution.reason': 1,
          'penaltyAttribution.rule': 1, 'penaltyAttribution.applications': 1 } }],
    } },
  ];
  type Row = { height: number; hash: string; time: Date;
    penaltyAttribution?: Pick<PenaltyAttribution, 'status' | 'reason' | 'rule' | 'applications'> | null; commitments: {
    txid: string; quorumType: number | null; quorumHash: string | null; version: number | null;
    quorumIndex: number | null; memberSlots: number | null; invalidSlots: number | null;
    status: PoseChainData['commitments'][number]['membershipStatus']; members: { proTxHash: string; valid: boolean }[];
  } };
  const [result] = await PoseChainBlock.aggregate<{
    totals: { total: number }[]; summary: PoseChainData['quorumSummary']; rows: Row[];
  }>(pipeline).option({ maxTimeMS: 10000 });
  if (config.poseChain.attributionEnabled) {
    const counts = await PoseChainBlock.aggregate<{ _id: string | null; count: number }>([
      { $match: { ...range, 'commitments.0': { $exists: true } } },
      { $group: { _id: '$penaltyAttribution.status', count: { $sum: 1 } } },
    ]).option({ maxTimeMS: 10000 });
    for (const row of counts) {
      data.penaltyCoverage.commitmentBlocks += row.count;
      const field = row._id === 'verified' ? 'verifiedBlocks' : row._id === 'state_unavailable' ? 'unavailableBlocks'
        : row._id === 'unsupported_context' ? 'unsupportedBlocks' : row._id === 'inconsistent' ? 'inconsistentBlocks'
          : row._id === 'not_applicable' ? 'notApplicableBlocks' : 'pendingBlocks';
      data.penaltyCoverage[field] += row.count;
    }
  }
  const rows = result?.rows ?? [];
  const anchors = rows.filter((row) => row.commitments.status === 'verified').map((row) => ({
    eventBlockHash: row.hash, eventBlockHeight: row.height,
    quorumType: row.commitments.quorumType, quorumHash: row.commitments.quorumHash,
    proTxHash: { $in: row.commitments.members.map((member) => member.proTxHash) },
  }));
  // Group in MongoDB rather than loading every retransmission/score variant.
  const observations = anchors.length ? await PoseObservation.aggregate<{
    _id: { blockHash: string; height: number; quorumType: number; quorumHash: string; proTxHash: string };
    nodeIds: string[];
  }>([
    { $match: { $or: anchors, expiresAt: { $gt: now }, eventAt: { $lte: now }, observedAt: { $lte: now },
      kind: { $in: ['penalty_change', 'ban', 'dkg_member'] } } },
    { $group: { _id: { blockHash: '$eventBlockHash', height: '$eventBlockHeight', quorumType: '$quorumType',
      quorumHash: '$quorumHash', proTxHash: '$proTxHash' }, nodeIds: { $addToSet: '$nodeId' } } },
  ]).option({ maxTimeMS: 10000 }) : [];
  data.total = result?.totals[0]?.total ?? 0;
  data.quorumSummary = result?.summary ?? [];
  data.commitments = rows.map((row) => {
    const c = row.commitments;
    const attribution = config.poseChain.attributionEnabled ? row.penaltyAttribution : null;
    const penaltyStatus: PoseChainData['commitments'][number]['penaltyAttributionStatus'] = !config.poseChain.attributionEnabled
      ? 'disabled' : !attribution || attribution.status === 'disabled' ? 'pending' : attribution.status;
    const related = observations.filter((observation) => observation._id.blockHash === row.hash
      && observation._id.height === row.height && observation._id.quorumType === c.quorumType
      && observation._id.quorumHash === c.quorumHash);
    return {
      blockHeight: row.height, blockHash: row.hash, blockTime: row.time.toISOString(), txid: c.txid,
      quorumType: c.quorumType, quorumHash: c.quorumHash, version: c.version, membershipStatus: c.status,
      quorumIndex: c.quorumIndex, memberSlots: c.memberSlots, invalidSlots: c.invalidSlots,
      evidence: c.status === 'verified' ? 'chain_verified_membership' : 'unknown',
      participantCount: c.members.length, invalidMemberCount: c.members.filter((member) => !member.valid).length,
      observerCount: new Set(related.flatMap((observation) => observation.nodeIds)).size,
      penaltyAttributionStatus: penaltyStatus,
      penaltyAttributionReason: penaltyStatus === 'disabled' ? 'disabled' : penaltyStatus === 'pending' ? null : attribution?.reason ?? null,
      penaltyRule: attribution?.status === 'verified' ? attribution.rule : null,
      members: c.members.map((member) => {
        const application = attribution?.status === 'verified'
          ? attribution.applications.find((item) => item.txid === c.txid && item.proTxHash === member.proTxHash) : undefined;
        const penalty = application ? { previousBlockPenalty: application.previousBlockPenalty,
          beforePenalty: application.beforePenalty, afterPenalty: application.afterPenalty, penaltyAmount: application.penaltyAmount,
          appliedDelta: application.appliedDelta, maxPenalty: application.maxPenalty, previousBanHeight: application.previousBanHeight,
          banHeight: application.banHeight, causedBan: application.causedBan } : null;
        return { ...member,
          observerCount: new Set(related.filter((observation) => observation._id.proTxHash === member.proTxHash)
            .flatMap((observation) => observation.nodeIds)).size,
          penaltyEvidence: (application ? 'chain_verified_penalty' : member.valid || penaltyStatus === 'verified'
            ? 'not_applicable' : 'unknown') as PoseChainData['commitments'][number]['members'][number]['penaltyEvidence'],
          penaltyReason: (application ? null : member.valid ? 'valid_member' : penaltyStatus === 'verified'
            ? 'not_registered' : 'attribution_unavailable') as PoseChainData['commitments'][number]['members'][number]['penaltyReason'],
          penalty,
        };
      }),
    };
  });
  // A rollback may have begun while the queries were pending. Fail closed.
  const after = await PoseChainState.findOne({ key: 'main' }).lean();
  const finalStatus = collectorStatus(after, new Date());
  if (!after || finalStatus !== 'ready' || config.poseChain.attributionEnabled !== attributionEnabled
    || after.revision !== state.revision || after.lastHash !== state.lastHash
    || after.startHeight !== state.startHeight || after.lastHeight !== state.lastHeight || after.targetHeight !== state.targetHeight
    || after.checkedAt?.getTime() !== state.checkedAt?.getTime()) {
    return { ...data, status: finalStatus === 'ready' ? 'collecting' : finalStatus, coverage: { ...data.coverage, caughtUp: false },
      total: 0, quorumSummary: [], commitments: [], penaltyCoverage: { ...data.penaltyCoverage,
        commitmentBlocks: 0, verifiedBlocks: 0, pendingBlocks: 0, unavailableBlocks: 0, unsupportedBlocks: 0,
        inconsistentBlocks: 0, notApplicableBlocks: 0 } };
  }
  return data;
}
