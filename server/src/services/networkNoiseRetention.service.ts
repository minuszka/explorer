import { config } from '../config';
import { NetworkNoiseBaseline, NetworkNoiseBatch } from '../models/NetworkNoiseBatch';
import { logger } from '../utils/logger';
import { PeriodicTask } from '../utils/periodicTask';
import type { SettledRange } from './networkNoiseBatch.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
const MAX_SETTLED_RANGES = 1000;

export type ReceiptRetentionResult = {
  /** Nodes with a baseline, the only ones a pass visits. */
  nodes: number;
  /** Nodes that recorded newly settled sequences in this pass. */
  recorded: number;
  /** Receipts deleted in this pass. */
  deleted: number;
};

/**
 * Merges sequences into ascending, non-adjacent ranges. Consecutive sequences share
 * a range, so the record stays small.
 */
export function addToSettledRanges(ranges: readonly SettledRange[], sequences: readonly number[]): SettledRange[] {
  const all = [...ranges, ...sequences.map((sequence) => ({ from: sequence, to: sequence }))].sort((a, b) => a.from - b.from);
  const merged: SettledRange[] = [];
  for (const { from, to } of all) {
    const last = merged[merged.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else merged.push({ from, to });
  }
  return merged;
}

/**
 * Bounds the growth of batch receipts without reopening replay. A receipt that no
 * request has touched for the retention period is settled: its batch was either
 * completed long ago or abandoned.
 *
 * Each pass works in two steps per node. It first deletes the settled receipts that
 * an earlier pass already recorded in the node's settled ranges, and only then
 * records the other settled receipts, without deleting those yet. `claim` refuses a
 * recorded sequence, so the record protects a sequence before its receipt goes. It
 * holds only sequences that had a receipt untouched for the whole period, so it never
 * refuses a delayed batch that was never seen or a batch still being worked on. A
 * node whose sequences would need too many ranges keeps its receipts instead, as it
 * did before retention: closing a gap could refuse exactly those batches.
 *
 * The record changes before the receipts it covers go, and only grows, so baselines
 * read after the receipts cover every receipt missing from them, however long the
 * dump takes. That is the order `scripts/ops/backup.sh` uses. Deleting one pass later
 * also keeps a dump in the other order consistent, unless it spans two passes.
 */
export class NetworkNoiseRetentionService {
  private readonly task = new PeriodicTask({
    intervalMs: INTERVAL_MS,
    startupDelayMs: STARTUP_DELAY_MS,
    run: async () => {
      const result = await this.pruneOnce();
      if (result.deleted > 0 || result.recorded > 0) {
        logger.info(`Network noise receipt retention: deleted ${result.deleted} receipts, recorded settled sequences for ${result.recorded} of ${result.nodes} nodes`);
      }
    },
    onError: (error) => logger.warn('Network noise receipt retention failed; receipts are kept until the next pass', error),
  });

  async start(): Promise<void> {
    if (config.networkNoise.enabled) await this.task.start();
  }

  stop(): void {
    this.task.stop();
  }

  async pruneOnce(now = new Date(), retentionDays = config.networkNoise.receiptRetentionDays): Promise<ReceiptRetentionResult> {
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    await Promise.all([NetworkNoiseBaseline.init(), NetworkNoiseBatch.init()]);

    // A node without a baseline has nowhere to record its sequences, so it is skipped.
    const baselines = await NetworkNoiseBaseline.find({}).select({ nodeId: 1, settledRanges: 1, rangesRevision: 1 }).lean();
    const result: ReceiptRetentionResult = { nodes: baselines.length, recorded: 0, deleted: 0 };

    for (const { nodeId, settledRanges, rangesRevision } of baselines) {
      const ranges: readonly SettledRange[] = settledRanges ?? [];
      // 1. Delete what an earlier pass recorded, once settled. A receipt touched
      //    since then stays until it has been untouched for the period.
      for (const { from, to } of ranges) {
        const removed = await NetworkNoiseBatch.deleteMany({ nodeId, sequence: { $gte: from, $lte: to }, updatedAt: { $lte: cutoff } });
        result.deleted += removed.deletedCount;
      }

      // 2. Record the other settled receipts. A receipt created or touched while this
      //    pass runs is inside the period and therefore not counted.
      const settled = await NetworkNoiseBatch.find({ nodeId, updatedAt: { $lte: cutoff } }).select({ sequence: 1 }).lean();
      if (settled.length === 0) continue;
      const record = addToSettledRanges(ranges, settled.map(({ sequence }) => sequence));
      if (record.length > MAX_SETTLED_RANGES) {
        logger.warn(`Network noise receipt retention: ${nodeId} would need ${record.length} ranges of settled sequences; its receipts are kept until its gaps close`);
        continue;
      }
      // A pass holding an older record must not overwrite a newer one: receipts the
      // newer record covers may already be gone. It tries again on its next run.
      const written = await NetworkNoiseBaseline.updateOne({ nodeId, rangesRevision: rangesRevision ?? null },
        { $set: { settledRanges: record }, $inc: { rangesRevision: 1 } });
      if (written.modifiedCount === 1) result.recorded += 1;
    }
    return result;
  }
}

export const networkNoiseRetentionService = new NetworkNoiseRetentionService();
