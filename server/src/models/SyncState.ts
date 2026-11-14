import mongoose, { Schema, Document } from 'mongoose';

export interface SyncStateDocument extends Document {
  key: string;
  lastSyncedHeight: number;
  lastSyncedHash: string;
  lastSyncedAt: Date;
  isRunning: boolean;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  addressRebuildRequired: boolean;
  error: string | null;
  addressIndexVersion?: number;
  satoshiDataVersion?: number;
  addressStatsVersion?: number;
}

const syncStateSchema = new Schema<SyncStateDocument>({
  key: { type: String, required: true, unique: true, default: 'main' },
  lastSyncedHeight: { type: Number, default: -1 },
  lastSyncedHash: { type: String, default: '' },
  lastSyncedAt: { type: Date, default: Date.now },
  isRunning: { type: Boolean, default: false },
  startedAt: { type: Date, default: null },
  heartbeatAt: { type: Date, default: null },
  addressRebuildRequired: { type: Boolean, default: false },
  error: { type: String, default: null },
  addressIndexVersion: { type: Number, default: 0 },
  satoshiDataVersion: { type: Number, default: 0 },
  // Version of how address statistics are counted; an older one rebuilds the address index once.
  addressStatsVersion: { type: Number, default: 0 },
});

export const SyncState = mongoose.model<SyncStateDocument>('SyncState', syncStateSchema);
