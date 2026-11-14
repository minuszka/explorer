import mongoose, { Schema, Document } from 'mongoose';

export interface AddressDocument extends Document {
  address: string;
  balanceSat: mongoose.Types.Decimal128;
  totalReceivedSat: mongoose.Types.Decimal128;
  totalSentSat: mongoose.Types.Decimal128;
  txCount: number;
  firstSeen: number;
  lastSeen: number;
}

const addressSchema = new Schema<AddressDocument>(
  {
    address: { type: String, required: true, unique: true, index: true },
    balanceSat: { type: Schema.Types.Decimal128, default: '0', index: true },
    totalReceivedSat: { type: Schema.Types.Decimal128, default: '0' },
    totalSentSat: { type: Schema.Types.Decimal128, default: '0' },
    txCount: { type: Number, default: 0 },
    firstSeen: { type: Number, default: 0 },
    lastSeen: { type: Number, default: 0 },
  },
  { timestamps: true }
);

addressSchema.index({ balanceSat: -1 });
addressSchema.index({ firstSeen: -1 });

export const Address = mongoose.model<AddressDocument>('Address', addressSchema);

// A rebuild of the address index writes into this collection and then renames it over the live
// one (sync.service), so readers never see a half-built index. It exists only during a rebuild:
// the model neither creates the collection nor its indexes on its own.
export const ADDRESS_REBUILD_COLLECTION = 'addresses_rebuild';
const addressRebuildSchema = addressSchema.clone();
addressRebuildSchema.set('autoCreate', false);
addressRebuildSchema.set('autoIndex', false);
export const AddressRebuild = mongoose.model<AddressDocument>('AddressRebuild', addressRebuildSchema, ADDRESS_REBUILD_COLLECTION);
