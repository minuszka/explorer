import { Schema, model, type InferSchemaType } from 'mongoose';

// Agent observations, not canonical chain events. Keep their lifecycle separate
// from Network Noise's short-lived, fingerprint-aggregated signals.
const poseObservationSchema = new Schema({
  observationKey: { type: String, required: true, unique: true },
  eventKey: { type: String, required: true, index: true },
  identityComplete: { type: Boolean, required: true },
  nodeId: { type: String, required: true },
  nodeRole: { type: String, required: true, enum: ['seed', 'fullnode', 'test_mn', 'masternode', 'unknown'] },
  agentVersion: { type: String, required: true },
  schemaVersion: { type: Number, required: true, enum: [2] },
  walletVersion: { type: String, default: null },
  sequence: { type: Number, required: true },
  eventId: { type: String, required: true },
  kind: { type: String, required: true, enum: ['penalty_change', 'ban', 'recovery', 'dkg_member', 'quorum_build_failure'] },
  eventAt: { type: Date, required: true, index: true },
  observedAt: { type: Date, required: true },
  receivedAt: { type: Date, required: true },
  // Report and event times checked against the batch receipt; older records have no flag.
  timeVerified: { type: Boolean },
  eventBlockHeight: { type: Number, default: null },
  eventBlockHash: { type: String, default: null },
  quorumType: { type: Number, default: null },
  quorumHash: { type: String, default: null },
  proTxHash: { type: String, default: null },
  previousPenalty: { type: Number, default: null },
  penalty: { type: Number, default: null },
  poseBanHeight: { type: Number, default: null },
  memberValid: { type: Boolean, default: null },
  sample: { type: String, default: null, maxlength: 300 },
  // Explicit names prevent later backfills from treating these as event anchors.
  snapshotBlockHeight: { type: Number, default: null },
  snapshotBlockHash: { type: String, default: null },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

poseObservationSchema.index({ proTxHash: 1, eventAt: -1 });
poseObservationSchema.index({ quorumType: 1, eventAt: -1 });
poseObservationSchema.index({ kind: 1, eventAt: -1 });
poseObservationSchema.index({ eventBlockHash: 1, eventBlockHeight: 1, quorumType: 1, quorumHash: 1, proTxHash: 1 });
export type PoseObservationDocument = InferSchemaType<typeof poseObservationSchema>;
export const PoseObservation = model<PoseObservationDocument>('PoseObservation', poseObservationSchema);
