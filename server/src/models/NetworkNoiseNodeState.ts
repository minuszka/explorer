import { Schema, model, type InferSchemaType } from 'mongoose';

const networkNoiseNodeStateSchema = new Schema(
  {
    nodeId: { type: String, required: true, trim: true, unique: true, index: true },
    nodeRole: {
      type: String,
      enum: ['seed', 'fullnode', 'test_mn', 'masternode', 'unknown'],
      default: 'unknown',
      index: true,
    },
    ip: { type: String, required: true, trim: true, index: true },
    walletVersion: { type: String, default: null, index: true },
    agentVersion: { type: String, default: null },
    lastSequence: { type: Number, required: true, default: 0 },
    lastReportedAt: { type: Date, required: true, index: true },
    blockHeight: { type: Number, default: null },
    bestBlockHash: { type: String, default: null },
    chainLockHeight: { type: Number, default: null },
    chainLockHash: { type: String, default: null },
    connections: { type: Number, default: null },
    inbound: { type: Number, default: null },
    outbound: { type: Number, default: null },
    syncing: { type: Boolean, default: null },
    noiseScore: { type: Number, required: true, default: 0, min: 0, max: 100 },
    signalCount: { type: Number, required: true, default: 0, min: 0 },
    // Legacy snapshots with signals have no verified signal-time flag.
    signalTimingInvalid: { type: Boolean, default: false },
    signalIntervalVerified: { type: Boolean, default: false },
    activeSignalTypes: { type: [String], default: [] },
    lastCleanAt: { type: Date, default: null },
  },
  { timestamps: true }
);

networkNoiseNodeStateSchema.index({ lastReportedAt: -1, noiseScore: -1 });
networkNoiseNodeStateSchema.index({ walletVersion: 1, noiseScore: -1 });

export type NetworkNoiseNodeStateDocument = InferSchemaType<
  typeof networkNoiseNodeStateSchema
>;

export const NetworkNoiseNodeState = model<NetworkNoiseNodeStateDocument>(
  'NetworkNoiseNodeState',
  networkNoiseNodeStateSchema
);
