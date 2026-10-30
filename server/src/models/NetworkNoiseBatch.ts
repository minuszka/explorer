import { Schema, model } from 'mongoose';

// The baseline is fixed before this server accepts its first batch for a node.
// Older sequences cannot be reconstructed from the legacy high-water mark.
const baselineSchema = new Schema({
  nodeId: { type: String, required: true, unique: true },
  legacySequence: { type: Number, required: true },
}, { timestamps: true });

const batchSchema = new Schema({
  nodeId: { type: String, required: true },
  sequence: { type: Number, required: true },
  digest: { type: String, required: true },
  // Only a schema 1 receipt can be replaced by different content.
  schemaVersion: { type: Number },
  // Set once different content has replaced this receipt: its signals then merge
  // into the rows the earlier content stored.
  replaced: { type: Boolean },
  // Arrival of the request that created the receipt and the batch's time limit
  // (that arrival plus the clock-skew allowance then in force). They change only
  // when new content replaces a schema 1 receipt; receipts created before these
  // fields lack them.
  firstReceivedAt: { type: Date },
  timeLimitAt: { type: Date },
  complete: { type: Boolean, required: true, default: false },
}, { timestamps: true });
batchSchema.index({ nodeId: 1, sequence: 1 }, { unique: true });

export const NetworkNoiseBaseline = model('NetworkNoiseBaseline', baselineSchema);
export const NetworkNoiseBatch = model('NetworkNoiseBatch', batchSchema);
