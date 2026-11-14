import { config } from '../config';
import { logger } from '../utils/logger';
import { rpcService } from './rpc.service';
import { invalidateChainTip } from './chainTip.service';
import { invalidateDashboardCache } from '../routes/dashboard.routes';
import { invalidateRichlistCache } from '../routes/richlist.routes';
import { Block } from '../models/Block';
import { Transaction } from '../models/Transaction';
import { Address } from '../models/Address';
import { SyncState } from '../models/SyncState';
import mongoose from 'mongoose';
import { COIN } from '@defcon/shared';
import type { RpcBlock, RpcTransaction } from '../types/rpc';
import { ScriptAddressResolver } from '../utils/scriptAddressResolver';
import { ReorgHandler } from './reorgHandler';
import { coinToSat } from '../utils/amounts';
import { mapPublicSyncError } from '../utils/publicSyncError';
import { realtimeService } from './realtime.service';
import { telegramService } from './telegram.service';
import type { WsSyncStatusPayload } from '../types/realtime';
import {
  buildSyncStatusPayload,
  planCatchUp,
  planStartupRecovery,
  shouldPersistSyncCheckpoint,
} from './sync/syncState';
import {
  buildAddressDeltaPipeline,
  canApplyAddressDeltas,
  collectAddressDeltas,
  collectInvolvedAddresses,
  mergeAddressDeltas,
  normalizeSat,
} from './sync/addressIndexing';
import { runScheduledSyncAttempt } from './sync/syncScheduling';

// ── Local stored-document types ──────────────────────────────────────

interface StoredVin {
  txid?: string;
  vout?: number;
  scriptSig?: { asm: string; hex: string };
  coinbase?: string;
  sequence: number;
  valueSat?: mongoose.Types.Decimal128;
  address?: string;
}

interface ProcessedBlockSummary {
  hash: string;
  height: number;
  time: number;
  txids: string[];
  minedBy?: string;
}

// ── Sync Service ────────────────────────────────────────────────────

class SyncService {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  // Set by stop(): the running sync ends after its current block, and no new run starts.
  private stopRequested = false;
  private currentSync: Promise<void> | null = null;
  // How long stop() waits for the current block before it leaves the lock to startup recovery.
  private stopTimeoutMs = 15_000;
  private readonly LOG_INTERVAL = 100;
  private readonly REBUILD_LOG_INTERVAL = 10000;
  private readonly ADDRESS_BULK_FLUSH_THRESHOLD = 2000;
  private readonly SYNC_STATE_CHECKPOINT_BLOCK_INTERVAL = 5;
  private readonly SYNC_STATE_CHECKPOINT_MAX_MS = 2000;
  private readonly CURSOR_MAX_TIME_MS = Math.max(30_000, config.rpc.timeout);
  private readonly ADDRESS_INDEX_VERSION = 3;
  private readonly SATOSHI_DATA_VERSION = 3;
  private readonly SAT_MULTIPLIER = 10 ** COIN.DECIMALS;
  private readonly TX_EVENT_MAX_PER_BLOCK = 250;

  private readonly addressResolver = new ScriptAddressResolver();
  private readonly reorgHandler = new ReorgHandler(() => this.rebuildAddressIndexFromTransactions());

  private blockVerbosity2Broken = false;
  private warnedVerbosity2Fallback = false;
  private blockVerbosity2FallbackUntil = 0;
  private readonly BLOCK_VERBOSITY2_RETRY_MS = 5 * 60 * 1000;

  private publishSyncStatus(
    state: WsSyncStatusPayload['state'],
    daemonHeight: number,
    lastSyncedHeight: number,
    opts?: { message?: string; error?: string | null }
  ): void {
    realtimeService.publishSyncStatus(
      buildSyncStatusPayload(state, daemonHeight, lastSyncedHeight, opts)
    );
  }

  private publishBlockEvents(block: ProcessedBlockSummary, emitTxEvents: boolean): void {
    realtimeService.publishNewBlock({
      hash: block.hash,
      height: block.height,
      time: block.time,
      txCount: block.txids.length,
      minedBy: block.minedBy,
    });
    telegramService.notifyNewBlock(block.height);

    if (!emitTxEvents) return;

    const txEmitCount = Math.min(block.txids.length, this.TX_EVENT_MAX_PER_BLOCK);
    for (let index = 0; index < txEmitCount; index++) {
      realtimeService.publishNewTx({
        txid: block.txids[index],
        blockHash: block.hash,
        blockHeight: block.height,
        blockTime: block.time,
        index,
      });
    }
  }

  private prevoutCacheKey(txid: string, voutIndex: number): string {
    return `${txid}:${voutIndex}`;
  }

  private toDecimal128(amountSat: bigint): mongoose.Types.Decimal128 {
    return mongoose.Types.Decimal128.fromString(amountSat.toString());
  }

  private async markAddressRebuildRequired(reason: string): Promise<void> {
    logger.error(reason);
    await SyncState.findOneAndUpdate(
      { key: 'main' },
      {
        addressRebuildRequired: true,
        heartbeatAt: new Date(),
      },
      { upsert: true }
    );
  }

  /**
   * Sets addressRebuildRequired before a block's first write (see processBlock) and says whether it
   * was already set, so that the block does not clear a rebuild requested for another reason.
   */
  private async markBlockInProgress(): Promise<boolean> {
    const before = await SyncState.findOneAndUpdate(
      { key: 'main' },
      { addressRebuildRequired: true, heartbeatAt: new Date() },
      { upsert: true, new: false }
    )
      .select({ addressRebuildRequired: 1 })
      .lean<{ addressRebuildRequired?: boolean }>();
    return before?.addressRebuildRequired === true;
  }

  private async recoverStartupState(): Promise<void> {
    const syncState = await SyncState.findOne({ key: 'main' }).lean();
    const indexedTip = await Block.findOne({})
      .sort({ height: -1 })
      .select({ height: 1, hash: 1 })
      .lean<{ height: number; hash: string }>();
    const recoveryPlan = planStartupRecovery(syncState, indexedTip ?? null);

    if (recoveryPlan.initializeCursor) {
      // First boot / missing state doc: initialize from indexed tip if present.
      await SyncState.findOneAndUpdate(
        { key: 'main' },
        {
          isRunning: false,
          startedAt: null,
          heartbeatAt: new Date(),
          lastSyncedHeight: recoveryPlan.initializeCursor.height,
          lastSyncedHash: recoveryPlan.initializeCursor.hash,
        },
        { upsert: true }
      );
      return;
    }

    // If sync state points past our indexed tip (possible after crash during rollback),
    // clamp to the real indexed tip so the next sync loop can continue safely.
    if (recoveryPlan.correctCursor) {
      logger.warn(
        `Sync cursor did not match indexed tip; correcting to height ${recoveryPlan.correctCursor.height}.`
      );
      await SyncState.findOneAndUpdate(
        { key: 'main' },
        {
          lastSyncedHeight: recoveryPlan.correctCursor.height,
          lastSyncedHash: recoveryPlan.correctCursor.hash,
          heartbeatAt: new Date(),
          addressRebuildRequired: true,
        },
        { upsert: true }
      );
    }

    if (recoveryPlan.resetStaleLock) {
      logger.warn('Detected stale sync lock from previous run. Resetting state and scheduling address rebuild.');
      await SyncState.findOneAndUpdate(
        { key: 'main' },
        {
          isRunning: false,
          startedAt: null,
          heartbeatAt: new Date(),
          addressRebuildRequired: true,
        },
        { upsert: true }
      );
    }

    if (!recoveryPlan.rebuildAddressIndex) return;

    logger.warn('Detected pending address index rebuild flag. Rebuilding from transactions...');
    await this.rebuildAddressIndexFromTransactions();

    await SyncState.findOneAndUpdate(
      { key: 'main' },
      {
        addressRebuildRequired: false,
        heartbeatAt: new Date(),
      },
      { upsert: true }
    );
    logger.info('Pending address rebuild recovered successfully.');
  }

  // Rebuild address balances from stored transactions.
  // This gives a deterministic recovery path after rollback/restart on MongoDB tiers
  // where multi-collection transactions are unavailable.
  private async rebuildAddressIndexFromTransactions(): Promise<void> {
    await Address.deleteMany({});

    const cursor = Transaction.find({})
      // Sort by blockheight to guarantee correct chronological order for balance deltas.
      // The compound index { blockheight: -1, _id: -1 } exists; ascending scan is fine.
      .sort({ blockheight: 1, _id: 1 })
      .select({ vin: 1, vout: 1, isCoinbase: 1, blocktime: 1 })
      .maxTimeMS(this.CURSOR_MAX_TIME_MS)
      .lean()
      .cursor();

    let scanned = 0;
    let applied = 0;
    const bulkOps: Array<{
      updateOne: {
        filter: { address: string };
        update: Array<Record<string, unknown>>;
        upsert: true;
      };
    }> = [];

    const flushBulk = async () => {
      if (bulkOps.length === 0) return;
      await Address.bulkWrite(bulkOps, { ordered: false });
      bulkOps.length = 0;
    };

    for await (const tx of cursor) {
      scanned++;
      if (!canApplyAddressDeltas(tx.vin || [], !!tx.isCoinbase)) {
        continue;
      }

      const addressMap = new Map<string, { receivedSat: bigint; sentSat: bigint }>();

      for (const vout of tx.vout || []) {
        const addresses = vout.scriptPubKey?.addresses;
        if (!addresses?.length) continue;
        const valueSat = normalizeSat(vout.valueSat);
        for (const addr of addresses) {
          const entry = addressMap.get(addr) || { receivedSat: 0n, sentSat: 0n };
          entry.receivedSat += valueSat;
          addressMap.set(addr, entry);
        }
      }

      if (!tx.isCoinbase) {
        for (const vin of tx.vin || []) {
          const valueSat = normalizeSat(vin.valueSat);
          if (!vin.address || valueSat <= 0n) continue;
          const entry = addressMap.get(vin.address) || { receivedSat: 0n, sentSat: 0n };
          entry.sentSat += valueSat;
          addressMap.set(vin.address, entry);
        }
      }

      for (const [addr, update] of addressMap) {
        bulkOps.push({
          updateOne: {
            filter: { address: addr },
            update: buildAddressDeltaPipeline(addr, update, tx.blocktime),
            upsert: true,
          },
        });
      }

      applied++;
      if (bulkOps.length >= this.ADDRESS_BULK_FLUSH_THRESHOLD) {
        await flushBulk();
      }
      if (applied % this.REBUILD_LOG_INTERVAL === 0) {
        logger.info(`Address rebuild progress: ${applied} transactions applied (${scanned} scanned)`);
      }
    }

    await flushBulk();
    logger.info(`Address index rebuild complete (${applied} applied / ${scanned} scanned).`);
  }

  private async ensureSatoshiDataVersion(): Promise<void> {
    const syncState = await SyncState.findOne({ key: 'main' }).lean();
    const currentVersion = syncState?.satoshiDataVersion ?? 0;
    if (currentVersion >= this.SATOSHI_DATA_VERSION) return;

    logger.warn(`Satoshi data migration started (${currentVersion} -> ${this.SATOSHI_DATA_VERSION}).`);

    let nextVersion = currentVersion;

    if (currentVersion < 1) {
      await Address.updateMany(
        {},
        [
          {
            $set: {
              balanceSat: {
                $ifNull: [
                  '$balanceSat',
                  {
                    $round: [
                      { $multiply: [{ $ifNull: ['$balance', 0] }, this.SAT_MULTIPLIER] },
                      0,
                    ],
                  },
                ],
              },
              totalReceivedSat: {
                $ifNull: [
                  '$totalReceivedSat',
                  {
                    $round: [
                      { $multiply: [{ $ifNull: ['$totalReceived', 0] }, this.SAT_MULTIPLIER] },
                      0,
                    ],
                  },
                ],
              },
              totalSentSat: {
                $ifNull: [
                  '$totalSentSat',
                  {
                    $round: [
                      { $multiply: [{ $ifNull: ['$totalSent', 0] }, this.SAT_MULTIPLIER] },
                      0,
                    ],
                  },
                ],
              },
            },
          },
        ]
      );

      await Block.updateMany(
        {},
        [
          {
            $set: {
              rewardSat: {
                $ifNull: [
                  '$rewardSat',
                  {
                    $round: [
                      { $multiply: [{ $ifNull: ['$reward', 0] }, this.SAT_MULTIPLIER] },
                      0,
                    ],
                  },
                ],
              },
              totalValueOutSat: {
                $ifNull: [
                  '$totalValueOutSat',
                  {
                    $round: [
                      { $multiply: [{ $ifNull: ['$totalValueOut', 0] }, this.SAT_MULTIPLIER] },
                      0,
                    ],
                  },
                ],
              },
            },
          },
        ]
      );

      await Transaction.updateMany(
        {},
        [
          {
            $set: {
              totalValueInSat: {
                $ifNull: [
                  '$totalValueInSat',
                  {
                    $round: [
                      { $multiply: [{ $ifNull: ['$totalValueIn', 0] }, this.SAT_MULTIPLIER] },
                      0,
                    ],
                  },
                ],
              },
              totalValueOutSat: {
                $ifNull: [
                  '$totalValueOutSat',
                  {
                    $round: [
                      { $multiply: [{ $ifNull: ['$totalValueOut', 0] }, this.SAT_MULTIPLIER] },
                      0,
                    ],
                  },
                ],
              },
              feeSat: {
                $ifNull: [
                  '$feeSat',
                  {
                    $round: [
                      { $multiply: [{ $ifNull: ['$fee', 0] }, this.SAT_MULTIPLIER] },
                      0,
                    ],
                  },
                ],
              },
              vin: {
                $map: {
                  input: { $ifNull: ['$vin', []] },
                  as: 'vin',
                  in: {
                    $mergeObjects: [
                      '$$vin',
                      {
                        valueSat: {
                          $ifNull: [
                            '$$vin.valueSat',
                            {
                              $round: [
                                {
                                  $multiply: [{ $ifNull: ['$$vin.value', 0] }, this.SAT_MULTIPLIER],
                                },
                                0,
                              ],
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
              vout: {
                $map: {
                  input: { $ifNull: ['$vout', []] },
                  as: 'vout',
                  in: {
                    $mergeObjects: [
                      '$$vout',
                      {
                        valueSat: {
                          $ifNull: [
                            '$$vout.valueSat',
                            {
                              $round: [
                                {
                                  $multiply: [{ $ifNull: ['$$vout.value', 0] }, this.SAT_MULTIPLIER],
                                },
                                0,
                              ],
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        ]
      );

      nextVersion = 1;
    }

    if (currentVersion < 2) {
      await Promise.all([
        Address.updateMany({}, { $unset: { balance: '', totalReceived: '', totalSent: '' } }),
        Block.updateMany({}, { $unset: { reward: '', totalValueOut: '' } }),
        Transaction.updateMany(
          {},
          {
            $unset: {
              totalValueIn: '',
              totalValueOut: '',
              fee: '',
              'vin.$[].value': '',
              'vout.$[].value': '',
            },
          }
        ),
      ]);

      nextVersion = 2;
    }

    if (currentVersion < 3) {
      await Promise.all([
        Address.updateMany(
          {},
          [
            {
              $set: {
                balanceSat: { $toDecimal: { $ifNull: ['$balanceSat', 0] } },
                totalReceivedSat: { $toDecimal: { $ifNull: ['$totalReceivedSat', 0] } },
                totalSentSat: { $toDecimal: { $ifNull: ['$totalSentSat', 0] } },
              },
            },
          ]
        ),
        Block.updateMany(
          {},
          [
            {
              $set: {
                rewardSat: { $toDecimal: { $ifNull: ['$rewardSat', 0] } },
                totalValueOutSat: { $toDecimal: { $ifNull: ['$totalValueOutSat', 0] } },
              },
            },
          ]
        ),
        Transaction.updateMany(
          {},
          [
            {
              $set: {
                totalValueInSat: { $toDecimal: { $ifNull: ['$totalValueInSat', 0] } },
                totalValueOutSat: { $toDecimal: { $ifNull: ['$totalValueOutSat', 0] } },
                feeSat: { $toDecimal: { $ifNull: ['$feeSat', 0] } },
                vin: {
                  $map: {
                    input: { $ifNull: ['$vin', []] },
                    as: 'vin',
                    in: {
                      $mergeObjects: [
                        '$$vin',
                        {
                          valueSat: { $toDecimal: { $ifNull: ['$$vin.valueSat', 0] } },
                        },
                      ],
                    },
                  },
                },
                vout: {
                  $map: {
                    input: { $ifNull: ['$vout', []] },
                    as: 'vout',
                    in: {
                      $mergeObjects: [
                        '$$vout',
                        {
                          valueSat: { $toDecimal: { $ifNull: ['$$vout.valueSat', 0] } },
                        },
                      ],
                    },
                  },
                },
              },
            },
          ]
        ),
      ]);

      nextVersion = 3;
    }

    await SyncState.findOneAndUpdate(
      { key: 'main' },
      {
        satoshiDataVersion: nextVersion,
        heartbeatAt: new Date(),
      },
      { upsert: true }
    );

    logger.info(`Satoshi data migration completed (v${nextVersion}).`);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Sync service is already running');
      return;
    }

    logger.info('Starting blockchain sync service...');
    this.stopRequested = false;

    await this.ensureIndexVersion();
    await this.ensureSatoshiDataVersion();
    await this.recoverStartupState();
    await this.addressResolver.preInferVersionByte();

    // Run initial sync
    await this.sync();

    // Set up periodic sync for new blocks.
    // Guard: skip if previous sync is still running to prevent overlap.
    this.intervalId = setInterval(() => {
      void runScheduledSyncAttempt({
        isBusy: () => this.isRunning,
        run: () => this.sync(),
        onSkipped: () => logger.debug('Skipping periodic sync: previous run still active'),
        onError: (error) => logger.error('Periodic sync error:', error),
      });
    }, config.sync.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.stopRequested = true;

    // A running sync stops between blocks and releases the lock itself. If the block in progress
    // does not finish in time, the lock stays: the next start sees it and rebuilds the address index.
    const running = this.currentSync;
    if (running) {
      let timer: NodeJS.Timeout | undefined;
      const finished = await Promise.race([
        running.then(() => true, () => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.stopTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (!finished) {
        logger.warn(`Sync did not stop within ${this.stopTimeoutMs} ms; leaving its lock for startup recovery.`);
        return;
      }
      logger.info('Sync service stopped');
      return;
    }

    await SyncState.findOneAndUpdate(
      { key: 'main' },
      {
        isRunning: false,
        startedAt: null,
        heartbeatAt: new Date(),
      },
      { upsert: true }
    );

    logger.info('Sync service stopped');
  }

  async sync(): Promise<void> {
    if (this.isRunning || this.currentSync || this.stopRequested) {
      return;
    }

    const run = this.runSync();
    this.currentSync = run;
    try {
      await run;
    } finally {
      if (this.currentSync === run) this.currentSync = null;
    }
  }

  private async runSync(): Promise<void> {
    const syncStartedAt = new Date();

    // Atomic DB-level lock: only acquire if not already running.
    // This prevents race conditions when multiple instances or overlapping calls exist.
    const lockAcquired = await SyncState.findOneAndUpdate(
      { key: 'main', isRunning: { $ne: true } },
      {
        isRunning: true,
        startedAt: syncStartedAt,
        heartbeatAt: syncStartedAt,
        error: null,
      },
      { upsert: true, new: true }
    );

    if (!lockAcquired || lockAcquired.isRunning !== true) {
      logger.debug('Sync lock not acquired — another instance is running');
      return;
    }

    this.isRunning = true;
    let daemonHeight = -1;
    let lastKnownSyncedHeight = -1;

    try {

      const preflightState = await SyncState.findOne({ key: 'main' }).lean();
      if (preflightState?.addressRebuildRequired === true) {
        logger.warn('addressRebuildRequired=true before sync. Rebuilding address index first.');
        await this.rebuildAddressIndexFromTransactions();
        await SyncState.findOneAndUpdate(
          { key: 'main' },
          {
            addressRebuildRequired: false,
            heartbeatAt: new Date(),
          },
          { upsert: true }
        );
      }

      // Get current daemon block height
      daemonHeight = await rpcService.getBlockCount();

      // Get our last synced height
      const syncState = await SyncState.findOne({ key: 'main' }).lean();
      let lastSyncedHeight = syncState?.lastSyncedHeight ?? -1;
      let lastHash = syncState?.lastSyncedHash ?? '';
      lastKnownSyncedHeight = lastSyncedHeight;

      // Check for chain reorganization even when heights are equal.
      if (lastSyncedHeight > 0) {
        const newHeight = await this.reorgHandler.checkForReorg(lastSyncedHeight);
        if (newHeight < lastSyncedHeight) {
          lastSyncedHeight = newHeight;
          const corrected = await SyncState.findOne({ key: 'main' })
            .select({ lastSyncedHash: 1 })
            .lean<{ lastSyncedHash?: string }>();
          lastHash = corrected?.lastSyncedHash ?? lastHash;
        }
      }

      const catchUpPlan = planCatchUp(lastSyncedHeight, daemonHeight);
      if (catchUpPlan.upToDate) {
        this.isRunning = false;
        await SyncState.findOneAndUpdate(
          { key: 'main' },
          {
            isRunning: false,
            startedAt: null,
            heartbeatAt: new Date(),
          }
        );
        this.publishSyncStatus('idle', daemonHeight, lastSyncedHeight, {
          message: 'Already at chain tip.',
        });
        return;
      }

      const syncStartHeight = lastSyncedHeight;
      const blocksToSync = catchUpPlan.blocksToSync;
      logger.info(
        `Syncing blocks ${syncStartHeight + 1} -> ${daemonHeight} (${blocksToSync} blocks)`
      );
      this.publishSyncStatus('started', daemonHeight, lastSyncedHeight, {
        message: `Syncing ${blocksToSync} blocks.`,
      });

      // Process blocks one by one so progress state stays crash-resilient.
      let currentHeight = catchUpPlan.startHeight;
      let lastCheckpointAt = Date.now();

      while (currentHeight <= daemonHeight) {
        // A requested stop takes effect between blocks, never in the middle of one.
        if (this.stopRequested) break;
        const processedBlock = await this.processBlock(currentHeight);
        lastHash = processedBlock.hash;
        lastKnownSyncedHeight = currentHeight;
        invalidateChainTip();
        invalidateDashboardCache();
        invalidateRichlistCache();

        const nearTip = currentHeight >= daemonHeight - 2;
        const emitTxEvents = blocksToSync <= 25 || nearTip;
        this.publishBlockEvents(processedBlock, emitTxEvents);

        // Checkpoint sync state periodically to reduce DB write pressure on long sync runs.
        const now = Date.now();
        const syncedRaw = currentHeight - syncStartHeight;
        if (
          shouldPersistSyncCheckpoint({
            currentHeight,
            syncStartHeight,
            daemonHeight,
            nowMs: now,
            lastCheckpointAtMs: lastCheckpointAt,
            blockInterval: this.SYNC_STATE_CHECKPOINT_BLOCK_INTERVAL,
            maxIntervalMs: this.SYNC_STATE_CHECKPOINT_MAX_MS,
          })
        ) {
          await SyncState.findOneAndUpdate(
            { key: 'main' },
            {
              lastSyncedHeight: currentHeight,
              lastSyncedHash: lastHash,
              lastSyncedAt: new Date(),
              isRunning: true,
              heartbeatAt: new Date(),
            },
            { upsert: true }
          );
          this.publishSyncStatus('syncing', daemonHeight, currentHeight);
          lastCheckpointAt = now;
        }

        const synced = Math.max(0, Math.min(blocksToSync, syncedRaw));
        if (synced % this.LOG_INTERVAL === 0 || currentHeight === daemonHeight) {
          const pct = (blocksToSync > 0 ? (synced / blocksToSync) * 100 : 100).toFixed(1);
          logger.info(`Sync progress: ${pct}% (block ${currentHeight}/${daemonHeight})`);
        }

        currentHeight++;

        // Yield to event loop periodically to avoid starving HTTP handlers
        if (currentHeight % 10 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      // Final update: the last block indexed, which is below the daemon's tip after a stop.
      const reachedHeight = currentHeight - 1;
      await SyncState.findOneAndUpdate(
        { key: 'main' },
        {
          lastSyncedHeight: reachedHeight,
          lastSyncedHash: lastHash,
          lastSyncedAt: new Date(),
          isRunning: false,
          startedAt: null,
          heartbeatAt: new Date(),
          error: null,
        },
        { upsert: true }
      );
      lastKnownSyncedHeight = reachedHeight;
      if (reachedHeight < daemonHeight) {
        this.publishSyncStatus('idle', daemonHeight, reachedHeight, { message: 'Sync stopped.' });
        logger.info(`Sync stopped at height ${reachedHeight}.`);
        return;
      }
      this.publishSyncStatus('complete', daemonHeight, daemonHeight, {
        message: 'Sync complete.',
      });

      logger.info(`Sync complete. Height: ${daemonHeight}`);
    } catch (error) {
      logger.error('Sync error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown sync error';
      await SyncState.findOneAndUpdate(
        { key: 'main' },
        {
          isRunning: false,
          startedAt: null,
          heartbeatAt: new Date(),
          error: errorMessage,
        },
        { upsert: true }
      );
      // WebSocket clients are public: broadcast the masked message, not the raw one.
      this.publishSyncStatus('error', daemonHeight, lastKnownSyncedHeight, {
        error: mapPublicSyncError(errorMessage, true).error,
      });
    } finally {
      this.isRunning = false;
    }
  }

  // ── Block Processing ────────────────────────────────────────────

  private async processBlock(height: number): Promise<ProcessedBlockSummary> {
    const hash = await rpcService.getBlockHash(height);

    const existingBlock = await Block.findOne({ height })
      .select({ hash: 1, height: 1, time: 1, txids: 1, minedBy: 1 })
      .lean<{ hash: string; height: number; time: number; txids?: string[]; minedBy?: string }>();
    if (existingBlock?.hash === hash) {
      return {
        hash,
        height: existingBlock.height,
        time: existingBlock.time,
        txids: existingBlock.txids ?? [],
        minedBy: existingBlock.minedBy,
      };
    }

    // Prefer `getblock` verbosity=2 for efficiency, but some forks/nodes have bugs
    // serializing full transactions (TxToUniv). Fall back to verbosity=1 + per-tx
    // `getrawtransaction` when needed.
    let rpcBlock: RpcBlock;
    const nowMs = Date.now();
    const canRetryVerbosity2 =
      !this.blockVerbosity2Broken || nowMs >= this.blockVerbosity2FallbackUntil;

    if (canRetryVerbosity2 || height === 0) {
      try {
        rpcBlock = (await rpcService.getBlock(hash, 2)) as RpcBlock;
        if (this.blockVerbosity2Broken) {
          logger.info('getblock verbosity=2 recovered; switching back to fast path.');
          this.blockVerbosity2Broken = false;
          this.blockVerbosity2FallbackUntil = 0;
        }
      } catch {
        this.blockVerbosity2Broken = true;
        this.blockVerbosity2FallbackUntil = Date.now() + this.BLOCK_VERBOSITY2_RETRY_MS;
        if (!this.warnedVerbosity2Fallback) {
          this.warnedVerbosity2Fallback = true;
          logger.warn(
            'getblock verbosity=2 failed; falling back to verbosity=1 + getrawtransaction (will retry periodically).'
          );
        }
        rpcBlock = (await rpcService.getBlock(hash, 1)) as RpcBlock;
      }
    } else {
      rpcBlock = (await rpcService.getBlock(hash, 1)) as RpcBlock;
    }

    // From here on the block is written piece by piece: each transaction (marked as applied), then
    // the block's balance changes, then the block. Mark the block as in progress before the first
    // write and clear the mark after the last. If anything in between fails, or the process stops,
    // the mark stays and the next run rebuilds the address index from the stored transactions; the
    // per-transaction marks then apply exactly what is still missing. If the mark cannot be
    // written, nothing is.
    const rebuildPendingBefore = await this.markBlockInProgress();

    const mintSat = coinToSat(typeof rpcBlock.mint === 'number' ? rpcBlock.mint : 0);
    let rewardSat = mintSat;
    let totalValueOutSat = 0n;
    let minedBy: string | undefined;
    const txids: string[] = [];
    const blockAddressDeltas = new Map<string, { receivedSat: bigint; sentSat: bigint }>();

    const txEntries = (rpcBlock.tx || []) as Array<string | RpcTransaction>;

    for (const entry of txEntries) {
      const txid = typeof entry === 'string' ? entry : entry.txid;
      txids.push(txid);

      let rpcTx: RpcTransaction;
      if (typeof entry === 'string') {
        try {
          rpcTx = (await rpcService.getRawTransaction(txid, true, rpcBlock.hash)) as RpcTransaction;
        } catch (err) {
          // Some nodes refuse to return the genesis coinbase via getrawtransaction.
          const fullBlock = (await rpcService.getBlock(rpcBlock.hash, 2)) as RpcBlock;
          const embedded = (fullBlock.tx || []).find(
            (t) => typeof t !== 'string' && t.txid === txid
          ) as RpcTransaction | undefined;
          if (!embedded) throw err;
          rpcTx = embedded;
        }
      } else {
        rpcTx = entry;
      }

      const result = await this.processTransaction(rpcTx, rpcBlock);
      if (result.addressDeltas) {
        mergeAddressDeltas(blockAddressDeltas, result.addressDeltas);
      }

      // "Extracted by" / miner address: first spendable output address from the coinbase tx.
      if (result.isCoinbase && !minedBy) {
        for (const vout of rpcTx.vout || []) {
          let outAddresses =
            vout.scriptPubKey.addresses ||
            (vout.scriptPubKey.address ? [vout.scriptPubKey.address] : []);

          if (!outAddresses?.length && vout.scriptPubKey.type === 'pubkey') {
            const derived = this.addressResolver.deriveAddressFromPubkeyAsm(vout.scriptPubKey.asm);
            if (derived) outAddresses = [derived];
          }

          if (outAddresses?.[0]) {
            minedBy = outAddresses[0];
            break;
          }
        }
      }

      // Fallback for chains that don't provide `mint` on blocks.
      if (rewardSat === 0n && result.isCoinbase) {
        rewardSat = result.totalValueOutSat;
      }

      totalValueOutSat += result.totalValueOutSat;
    }

    if (blockAddressDeltas.size > 0) {
      try {
        await this.applyAddressDeltas(blockAddressDeltas, rpcBlock.time);
      } catch (error) {
        await this.markAddressRebuildRequired(
          `Address batch update failed for block ${rpcBlock.height}; forcing deterministic rebuild.`
        );
        throw error;
      }
    }

    // Save block
    // Note: confirmations are computed at read time from current tip height.
    // Persisting RPC confirmations here would immediately become stale.
    await Block.findOneAndUpdate(
      { hash: rpcBlock.hash },
      {
        hash: rpcBlock.hash,
        height: rpcBlock.height,
        size: rpcBlock.size,
        version: rpcBlock.version,
        merkleroot: rpcBlock.merkleroot,
        time: rpcBlock.time,
        mediantime: rpcBlock.mediantime,
        nonce: rpcBlock.nonce,
        bits: rpcBlock.bits,
        difficulty: rpcBlock.difficulty,
        chainwork: rpcBlock.chainwork,
        nTx: txids.length,
        previousblockhash: rpcBlock.previousblockhash,
        nextblockhash: rpcBlock.nextblockhash,
        minedBy,
        rewardSat: this.toDecimal128(rewardSat),
        totalValueOutSat: this.toDecimal128(totalValueOutSat),
        txids,
      },
      { upsert: true, new: true }
    );

    // Update previous block's nextblockhash pointer
    if (rpcBlock.previousblockhash) {
      await Block.findOneAndUpdate(
        { hash: rpcBlock.previousblockhash },
        { nextblockhash: rpcBlock.hash }
      );
    }

    // Everything of this block is written. A rebuild that was already pending stays pending.
    if (!rebuildPendingBefore) {
      await SyncState.findOneAndUpdate(
        { key: 'main' },
        { addressRebuildRequired: false, heartbeatAt: new Date() }
      );
    }

    return {
      hash: rpcBlock.hash,
      height: rpcBlock.height,
      time: rpcBlock.time,
      txids,
      minedBy,
    };
  }

  // ── Transaction Processing ──────────────────────────────────────

  /**
   * Stores one transaction and returns its balance changes, if they have not been applied before.
   * The caller (processBlock) merges them and writes them once for the whole block.
   */
  private async processTransaction(
    rpcTx: RpcTransaction,
    rpcBlock: RpcBlock
  ): Promise<{
    totalValueOutSat: bigint;
    isCoinbase: boolean;
    addressDeltas?: Map<string, { receivedSat: bigint; sentSat: bigint }>;
  }> {
    const isCoinbase = rpcTx.vin.length > 0 && !!rpcTx.vin[0].coinbase;

    // Process outputs
    let totalValueOutSat = 0n;
    const vouts = rpcTx.vout.map((vout) => {
      const valueSat = normalizeSat(vout.valueSat, vout.value);
      totalValueOutSat += valueSat;

      // Dash Core 21+ returns `scriptPubKey.address` by default and only returns
      // `addresses` when started with `-deprecatedrpc=addresses`.
      let outAddresses =
        vout.scriptPubKey.addresses ||
        (vout.scriptPubKey.address ? [vout.scriptPubKey.address] : []);

      // Infer the chain's P2PKH version byte from a real P2PKH address if available.
      if (vout.scriptPubKey.type === 'pubkeyhash' && outAddresses?.[0]) {
        this.addressResolver.maybeInferFromAddress(outAddresses[0]);
      }

      // Dash can return legacy P2PK outputs (type "pubkey") without an address.
      // Historically, `scriptPubKey.addresses` contained a computed P2PKH address for these,
      // but that field is now behind `-deprecatedrpc=addresses`. Derive it ourselves so
      // address balances / rich list can work on chains that use P2PK coinbase outputs.
      if (!outAddresses?.length && vout.scriptPubKey.type === 'pubkey') {
        const derived = this.addressResolver.deriveAddressFromPubkeyAsm(vout.scriptPubKey.asm);
        if (derived) outAddresses = [derived];
      }

      return {
        valueSat: this.toDecimal128(valueSat),
        n: vout.n,
        scriptPubKey: {
          asm: vout.scriptPubKey.asm,
          hex: vout.scriptPubKey.hex,
          reqSigs: vout.scriptPubKey.reqSigs,
          type: vout.scriptPubKey.type,
          addresses: outAddresses,
        },
      };
    });

    // Process inputs
    let totalValueInSat = 0n;
    const vins: StoredVin[] = [];
    const missingPrevouts: Array<{ txid: string; voutIndex: number }> = [];

    if (!isCoinbase) {
      for (const vin of rpcTx.vin) {
        if (!vin.txid || typeof vin.vout !== 'number') continue;
        const inputValueSat = normalizeSat(vin.valueSat, vin.value);
        const needsLookup = inputValueSat === 0n || !vin.address;
        if (needsLookup) {
          missingPrevouts.push({ txid: vin.txid, voutIndex: vin.vout });
        }
      }
    }

    const resolvedPrevouts =
      missingPrevouts.length > 0
        ? await this.resolvePreviousOutputsBatch(missingPrevouts)
        : new Map<string, { valueSat: bigint; address?: string }>();

    for (const vin of rpcTx.vin) {
      if (isCoinbase) {
        vins.push({
          coinbase: vin.coinbase,
          sequence: vin.sequence,
        });
      } else {
        let inputValueSat = normalizeSat(vin.valueSat, vin.value);
        let inputAddress = vin.address;

        // If daemon didn't provide value/address (no addressindex), look up prev tx
        if (vin.txid && typeof vin.vout === 'number' && (inputValueSat === 0n || !inputAddress)) {
          const prev = resolvedPrevouts.get(this.prevoutCacheKey(vin.txid, vin.vout));
          if (prev) {
            if (inputValueSat === 0n) inputValueSat = prev.valueSat;
            if (!inputAddress) inputAddress = prev.address;
          }
        }

        totalValueInSat += inputValueSat;
        vins.push({
          txid: vin.txid,
          vout: vin.vout,
          scriptSig: vin.scriptSig,
          sequence: vin.sequence,
          valueSat: this.toDecimal128(inputValueSat),
          address: inputAddress,
        });
      }
    }

    const feeSat = isCoinbase ? 0n : totalValueInSat > totalValueOutSat ? totalValueInSat - totalValueOutSat : 0n;
    const canApplyAddressDeltasForTx = canApplyAddressDeltas(vins, isCoinbase);
    const involvedAddresses = collectInvolvedAddresses(vins, vouts);
    const txSet: Record<string, unknown> = {
      txid: rpcTx.txid,
      blockhash: rpcBlock.hash,
      blockheight: rpcBlock.height,
      blocktime: rpcBlock.time,
      involvedAddresses,
      version: rpcTx.version,
      size: rpcTx.size,
      locktime: rpcTx.locktime,
      vin: vins,
      vout: vouts,
      totalValueInSat: this.toDecimal128(totalValueInSat),
      totalValueOutSat: this.toDecimal128(totalValueOutSat),
      feeSat: this.toDecimal128(feeSat),
      isCoinbase,
    };
    if (canApplyAddressDeltasForTx) {
      txSet.addressUpdatesApplied = true;
    }

    // Save transaction.
    // Note: confirmations are computed at read time from current tip height.
    // Persisting RPC confirmations here would immediately become stale.
    // $setOnInsert only applies on insert (upsert). If $set already contains
    // `addressUpdatesApplied` (when canApplyAddressDeltas=true), including the
    // same field in $setOnInsert causes a ConflictingUpdateOperators error.
    const updateOp = canApplyAddressDeltasForTx
      ? { $set: txSet }
      : { $set: txSet, $setOnInsert: { addressUpdatesApplied: false } };

    const previousTx = await Transaction.findOneAndUpdate(
      { txid: rpcTx.txid },
      updateOp,
      { upsert: true, new: false }
    )
      .select({ addressUpdatesApplied: 1 })
      .lean<{ addressUpdatesApplied?: boolean }>();

    const shouldApplyAddressDeltas =
      canApplyAddressDeltasForTx && previousTx?.addressUpdatesApplied !== true;
    if (shouldApplyAddressDeltas) {
      const addressDeltas = collectAddressDeltas(vins, vouts, isCoinbase);
      return {
        totalValueOutSat,
        isCoinbase,
        addressDeltas: addressDeltas.size > 0 ? addressDeltas : undefined,
      };
    }

    return { totalValueOutSat, isCoinbase };
  }

  // ── Input Resolution ────────────────────────────────────────────

  private async resolvePreviousOutputsBatch(
    refs: Array<{ txid: string; voutIndex: number }>
  ): Promise<Map<string, { valueSat: bigint; address?: string }>> {
    const resolved = new Map<string, { valueSat: bigint; address?: string }>();
    if (refs.length === 0) return resolved;

    const neededByTxid = new Map<string, Set<number>>();
    for (const ref of refs) {
      const set = neededByTxid.get(ref.txid) || new Set<number>();
      set.add(ref.voutIndex);
      neededByTxid.set(ref.txid, set);
    }

    const uniqueTxids = Array.from(neededByTxid.keys());

    // DB batch lookup first.
    const dbTxs = await Transaction.find({ txid: { $in: uniqueTxids } })
      .select({ txid: 1, vout: 1 })
      .lean();

    for (const dbTx of dbTxs) {
      const neededIndexes = neededByTxid.get(dbTx.txid);
      if (!neededIndexes) continue;

      for (const idx of neededIndexes) {
        const vout = dbTx.vout?.[idx];
        if (!vout) continue;

        const addrFromStored = vout.scriptPubKey?.addresses?.[0];
        const derivedAddr =
          !addrFromStored && vout.scriptPubKey?.type === 'pubkey' && vout.scriptPubKey?.asm
            ? this.addressResolver.deriveAddressFromPubkeyAsm(vout.scriptPubKey.asm)
            : null;
        const valueSat = normalizeSat(vout.valueSat);

        resolved.set(this.prevoutCacheKey(dbTx.txid, idx), {
          valueSat,
          address: addrFromStored || derivedAddr || undefined,
        });
      }
    }

    // Fallback only for txids still unresolved in DB.
    const unresolvedTxids = uniqueTxids.filter((txid) => {
      const neededIndexes = neededByTxid.get(txid);
      if (!neededIndexes) return false;
      for (const idx of neededIndexes) {
        if (!resolved.has(this.prevoutCacheKey(txid, idx))) {
          return true;
        }
      }
      return false;
    });

    const rpcResults = await Promise.all(
      unresolvedTxids.map(async (txid) => {
        try {
          const rawTx = (await rpcService.getRawTransaction(txid, true)) as RpcTransaction;
          return { txid, rawTx };
        } catch {
          return null;
        }
      })
    );

    for (const result of rpcResults) {
      if (!result?.rawTx) continue;
      const neededIndexes = neededByTxid.get(result.txid);
      if (!neededIndexes) continue;

      for (const idx of neededIndexes) {
        const key = this.prevoutCacheKey(result.txid, idx);
        if (resolved.has(key)) continue;

        const vout = result.rawTx?.vout?.[idx];
        if (!vout) continue;

        let outAddresses =
          vout.scriptPubKey?.addresses ||
          (vout.scriptPubKey?.address ? [vout.scriptPubKey.address] : []);
        if (
          !outAddresses?.length &&
          vout.scriptPubKey?.type === 'pubkey' &&
          vout.scriptPubKey?.asm
        ) {
          const derived = this.addressResolver.deriveAddressFromPubkeyAsm(vout.scriptPubKey.asm);
          if (derived) outAddresses = [derived];
        }

        resolved.set(key, {
          valueSat: normalizeSat(vout.valueSat, vout.value),
          address: outAddresses?.[0],
        });
      }
    }

    return resolved;
  }

  // ── Address Balance Updates ─────────────────────────────────────

  private async applyAddressDeltas(
    addressMap: Map<string, { receivedSat: bigint; sentSat: bigint }>,
    blocktime: number
  ): Promise<boolean> {
    if (addressMap.size === 0) return false;

    const bulkOps: Array<{
      updateOne: {
        filter: { address: string };
        update: Array<Record<string, unknown>>;
        upsert: true;
      };
    }> = [];
    for (const [addr, update] of addressMap) {
      bulkOps.push({
        updateOne: {
          filter: { address: addr },
          update: buildAddressDeltaPipeline(addr, update, blocktime),
          upsert: true,
        },
      });
    }

    await Address.bulkWrite(bulkOps, { ordered: false });

    return true;
  }

  private async ensureIndexVersion(): Promise<void> {
    const syncState = await SyncState.findOne({ key: 'main' }).lean();
    const currentVersion = syncState?.addressIndexVersion ?? 0;
    if (currentVersion >= this.ADDRESS_INDEX_VERSION) {
      await SyncState.findOneAndUpdate(
        { key: 'main' },
        {
          startedAt: syncState?.startedAt ?? null,
          heartbeatAt: syncState?.heartbeatAt ?? null,
          addressRebuildRequired: syncState?.addressRebuildRequired ?? false,
        },
        { upsert: true }
      );
      return;
    }

    const [blockCount, txCount, addressCount] = await Promise.all([
      Block.countDocuments(),
      Transaction.countDocuments(),
      Address.countDocuments(),
    ]);

    if (blockCount > 0 || txCount > 0 || addressCount > 0) {
      const totalDocs = blockCount + txCount + addressCount;
      if (!config.sync.allowDbWipe) {
        throw new Error(
          `Index version changed (${currentVersion} -> ${this.ADDRESS_INDEX_VERSION}) but automatic DB wipe is disabled. Set ALLOW_DB_WIPE=true to proceed.`
        );
      }
      if (totalDocs > config.sync.maxAutoWipeDocs) {
        throw new Error(
          `Refusing automatic DB wipe: ${totalDocs} docs exceed AUTO_WIPE_MAX_DOCS=${config.sync.maxAutoWipeDocs}.`
        );
      }

      logger.warn(
        `Index version changed (${currentVersion} -> ${this.ADDRESS_INDEX_VERSION}). Reindexing explorer DB...`
      );
      await Promise.all([
        Block.deleteMany({}),
        Transaction.deleteMany({}),
        Address.deleteMany({}),
      ]);
      logger.warn('Explorer DB cleared. A full resync will start now.');
    }

    await SyncState.findOneAndUpdate(
      { key: 'main' },
      {
        lastSyncedHeight: -1,
        lastSyncedHash: '',
        lastSyncedAt: new Date(),
        isRunning: false,
        startedAt: null,
        heartbeatAt: null,
        addressRebuildRequired: false,
        error: null,
        addressIndexVersion: this.ADDRESS_INDEX_VERSION,
        satoshiDataVersion: this.SATOSHI_DATA_VERSION,
      },
      { upsert: true }
    );
  }
}

export const syncService = new SyncService();
