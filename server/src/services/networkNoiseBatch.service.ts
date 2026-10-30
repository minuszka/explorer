import crypto from 'node:crypto';
import type { NetworkNoiseIngestPayload } from '@defcon/shared/dist/contracts';
import { config } from '../config';
import { NetworkNoiseBaseline, NetworkNoiseBatch } from '../models/NetworkNoiseBatch';
import { NetworkNoiseNodeState } from '../models/NetworkNoiseNodeState';
import { isDuplicateKeyOnly } from '../domain/pose/poseTelemetry';

export class NetworkNoiseSequenceConflict extends Error {}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

function digest(payload: NetworkNoiseIngestPayload): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

export const networkNoiseBatchService = {
  /**
   * `receivedAt` is this request's arrival. A processed batch reports its stored
   * first arrival and time limit (epoch ms) for checking agent times.
   */
  async claim(payload: NetworkNoiseIngestPayload, receivedAt: Date): Promise<
    { status: 'duplicate' } | { status: 'process'; firstReceivedAt: Date; timeLimit: number; resend: boolean }
  > {
    await Promise.all([NetworkNoiseBaseline.init(), NetworkNoiseBatch.init()]);
    // Every writer establishes the immutable baseline before it can advance state.
    const current = await NetworkNoiseNodeState.findOne({ nodeId: payload.nodeId })
      .select({ lastSequence: 1 }).lean();
    let baseline;
    try {
      baseline = await NetworkNoiseBaseline.findOneAndUpdate({ nodeId: payload.nodeId },
        { $setOnInsert: { legacySequence: current?.lastSequence ?? -1 } },
        { upsert: true, new: true }).lean();
    } catch (error) {
      if (!isDuplicateKeyOnly(error)) throw error;
      baseline = await NetworkNoiseBaseline.findOne({ nodeId: payload.nodeId }).lean();
    }
    if (!baseline) throw new Error('Network noise sequence baseline unavailable');
    if (payload.sequence <= baseline.legacySequence) return { status: 'duplicate' };

    const key = { nodeId: payload.nodeId, sequence: payload.sequence };
    const batchDigest = digest(payload);
    const receipt = { digest: batchDigest, schemaVersion: payload.schemaVersion, complete: false,
      firstReceivedAt: receivedAt, timeLimitAt: new Date(receivedAt.getTime() + config.networkNoise.clockSkewMs) };
    let batch;
    try {
      batch = await NetworkNoiseBatch.findOneAndUpdate(key, { $setOnInsert: receipt },
        { upsert: true, new: true }).lean();
    } catch (error) {
      if (!isDuplicateKeyOnly(error)) throw error;
      batch = await NetworkNoiseBatch.findOne(key).lean();
    }
    if (!batch) throw new Error('Network noise batch receipt unavailable');
    if (batch.digest !== batchDigest) {
      // A schema 2 receipt holds its batch to identical content.
      if (batch.schemaVersion !== 1) throw new NetworkNoiseSequenceConflict('Sequence already belongs to a different batch');
      // A schema 1 agent advances its sequence only after a successful response
      // and builds a new batch on every attempt. After a lost response or an
      // interrupted write it resends this sequence with new content for as long
      // as it is refused, so the newest content replaces the receipt instead.
      batch = await NetworkNoiseBatch.findOneAndUpdate({ ...key, digest: batch.digest },
        { $set: { ...receipt, replaced: true } }, { new: true }).lean();
      // Another attempt replaced it first; the agent resends on its next cycle.
      if (!batch) throw new NetworkNoiseSequenceConflict('Sequence already belongs to a different batch');
    }
    if (batch.complete) return { status: 'duplicate' };
    // Stored on the receipt, so an interrupted replacement still merges when retried.
    const resend = batch.replaced === true;
    // The request that created the receipt fixed the batch's arrival and time
    // limit; retries and concurrent identical requests reuse both, so every
    // verdict for the batch agrees, even after a restart with another allowance.
    // A receipt from an earlier version has no limit: no time is verified.
    if (!batch.firstReceivedAt || !batch.timeLimitAt) {
      return { status: 'process', firstReceivedAt: batch.createdAt, timeLimit: Number.NEGATIVE_INFINITY, resend };
    }
    return { status: 'process', firstReceivedAt: batch.firstReceivedAt, timeLimit: batch.timeLimitAt.getTime(), resend };
  },

  async complete(payload: NetworkNoiseIngestPayload): Promise<void> {
    const result = await NetworkNoiseBatch.updateOne(
      { nodeId: payload.nodeId, sequence: payload.sequence, digest: digest(payload) },
      { $set: { complete: true } },
    );
    if (result.matchedCount !== 1) throw new Error('Network noise batch receipt missing during completion');
  },
};
