import { Schema, model, type InferSchemaType } from 'mongoose';

const networkNoiseObservationSchema = new Schema(
  {
    dedupeKey: { type: String, required: true, unique: true, index: true },
    nodeId: { type: String, required: true, trim: true, index: true },
    nodeRole: {
      type: String,
      enum: ['seed', 'fullnode', 'test_mn', 'masternode', 'unknown'],
      default: 'unknown',
      index: true,
    },
    ip: { type: String, required: true, trim: true, index: true },
    walletVersion: { type: String, default: null, index: true },
    sequence: { type: Number, required: true },
    observedAt: { type: Date, required: true, index: true },
    // First receipt of the batch and its time check; older rows have neither.
    receivedAt: { type: Date },
    timeVerified: { type: Boolean },
    signalType: { type: String, required: true, trim: true, index: true },
    fingerprint: { type: String, required: true, trim: true, index: true },
    count: { type: Number, required: true, min: 1 },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true, index: true },
    peerIps: { type: [String], default: [] },
    sample: { type: String, default: null, maxlength: 300 },
    blockHeight: { type: Number, default: null },
    bestBlockHash: { type: String, default: null },
    chainLockHeight: { type: Number, default: null },
    chainLockHash: { type: String, default: null },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

networkNoiseObservationSchema.index({ nodeId: 1, lastSeenAt: -1 });
networkNoiseObservationSchema.index({ signalType: 1, lastSeenAt: -1 });
networkNoiseObservationSchema.index({ fingerprint: 1, lastSeenAt: -1 });

export type NetworkNoiseObservationDocument = InferSchemaType<
  typeof networkNoiseObservationSchema
>;

export const NetworkNoiseObservation = model<NetworkNoiseObservationDocument>(
  'NetworkNoiseObservation',
  networkNoiseObservationSchema
);
