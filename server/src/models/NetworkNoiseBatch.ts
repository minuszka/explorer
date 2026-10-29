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
  complete: { type: Boolean, required: true, default: false },
}, { timestamps: true });
batchSchema.index({ nodeId: 1, sequence: 1 }, { unique: true });

export const NetworkNoiseBaseline = model('NetworkNoiseBaseline', baselineSchema);
export const NetworkNoiseBatch = model('NetworkNoiseBatch', batchSchema);
