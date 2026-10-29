import type { BanAttributionData, BanAttributionQuery, BanAttributionUnknownReason, PoseChainData } from '@defcon/shared/dist/contracts';
import { config } from '../config';
import { PoseChainBlock } from '../models/PoseChainBlock';
import { PoseChainState, type PoseChainStateDocument } from '../models/PoseChainState';
import { PoseObservation } from '../models/PoseObservation';
import { resolveBanAttribution } from '../domain/pose/banAttribution';

function collectorStatus(state: PoseChainStateDocument | null, now: Date): PoseChainData['status'] {
  if (!config.poseChain.enabled) return 'disabled';
  if (!state || state.status === 'error') return 'unavailable';
  if (state.status !== 'ready') return 'collecting';
  const age = state.checkedAt ? now.getTime() - state.checkedAt.getTime() : Infinity;
  return age < 0 || age > Math.max(180000, config.poseChain.intervalMs * 3) ? 'stale' : 'ready';
}
export async function getBanAttribution(query: BanAttributionQuery): Promise<BanAttributionData> {
  const now = new Date();
  const state = await PoseChainState.findOne({ key: 'main' }).maxTimeMS(10000).lean();
  const status = collectorStatus(state, now);
  const enabled = config.poseChain.attributionEnabled;
  const confirmed = state?.targetHeight == null ? config.poseChain.startHeight - 1
    : Math.max(state.startHeight - 1, Math.min(state.lastHeight, state.targetHeight));
  const common = { code: 'BANNED_BY' as const, generatedAt: now.toISOString(), proTxHash: query.proTxHash,
    banHeight: query.banHeight, collectorStatus: status, attributionEnabled: enabled,
    coverage: { startHeight: state?.startHeight ?? config.poseChain.startHeight,
      lastHeight: state?.lastHeight ?? config.poseChain.startHeight - 1, lastHash: state?.lastHash ?? null,
      targetHeight: state?.targetHeight ?? null, checkedAt: state?.checkedAt?.toISOString() ?? null,
      lastReorgAt: state?.lastReorgAt?.toISOString() ?? null,
      remainingBlocks: state?.targetHeight == null ? null : Math.max(0, state.targetHeight - state.lastHeight),
      caughtUp: status === 'ready' && state?.targetHeight != null && state.lastHeight >= state.targetHeight,
      confirmedThroughHeight: confirmed } };
  const unknown = (reason: BanAttributionUnknownReason): BanAttributionData => ({ ...common, status: 'unknown',
    evidence: 'unknown', reason, proof: null, message: 'The requested ban has no publishable scoring attribution.',
    hint: 'Unknown does not mean no ban or no commitment; check the reported coverage and gap reason.' });
  if (status !== 'ready' || !state) return unknown(status === 'disabled' ? 'collector_disabled'
    : status === 'stale' ? 'collector_stale' : status === 'collecting' ? 'collector_collecting' : 'collector_unavailable');
  if (!enabled) return unknown('attribution_disabled');
  if (query.banHeight < state.startHeight) return unknown('before_coverage');
  if (query.banHeight > confirmed) return unknown('after_coverage');
  // One exact indexed canonical height; no polling, RPC, collection or database writes.
  const block = await PoseChainBlock.findOne({ canonical: true, height: query.banHeight }).lean().maxTimeMS(10000);
  let result: BanAttributionData;
  if (!block) result = unknown('block_unavailable');
  else if (query.blockHash && block.hash !== query.blockHash) result = unknown('block_hash_mismatch');
  else if (!block.penaltyAttribution || block.penaltyAttribution.status === 'disabled') result = unknown('pending');
  else if (block.penaltyAttribution.status !== 'verified') result = unknown(block.penaltyAttribution.status);
  else {
    const resolution = resolveBanAttribution(block, query, now);
    if (!resolution.proof) result = unknown(resolution.reason);
    else {
      const proof = resolution.proof;
      const observers = await PoseObservation.distinct('nodeId', {
        eventBlockHash: proof.blockHash, eventBlockHeight: proof.blockHeight,
        quorumType: proof.quorumType, quorumHash: proof.quorumHash, proTxHash: query.proTxHash,
        expiresAt: { $gt: now }, eventAt: { $lte: now }, observedAt: { $lte: now },
        kind: { $in: ['penalty_change', 'ban', 'dkg_member'] },
      }).maxTimeMS(10000);
      const name = proof.quorumType === 2 ? 'Q400_60' : proof.quorumType === 7 ? 'Q60/41' : `quorum type ${proof.quorumType}`;
      result = { ...common, status: 'verified', evidence: 'chain_verified_penalty', reason: null,
        proof: { ...proof, observerCount: observers.length },
        message: `${name} commitment caused this node's ban in block ${proof.blockHeight} (invalid DKG member).`,
        hint: 'Check DKG participation and connectivity logs. Verified scoring does not explain why the member was invalid; observer reports are separate unverified observations.' };
    }
  }
  // A rollback/ABA or freshness expiry while reading retracts every causal claim.
  const after = await PoseChainState.findOne({ key: 'main' }).maxTimeMS(10000).lean();
  if (!after || collectorStatus(after, new Date()) !== 'ready' || !config.poseChain.attributionEnabled
    || after.revision !== state.revision || after.lastHash !== state.lastHash
    || after.startHeight !== state.startHeight || after.lastHeight !== state.lastHeight || after.targetHeight !== state.targetHeight
    || after.checkedAt?.getTime() !== state.checkedAt?.getTime()) {
    common.collectorStatus = 'collecting'; common.coverage.caughtUp = false;
    return unknown('read_invalidated');
  }
  return result;
}
