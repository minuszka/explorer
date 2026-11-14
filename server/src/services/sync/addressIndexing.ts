import mongoose from 'mongoose';
import { coinToSat, satToBigInt } from '../../utils/amounts';

export interface AddressDelta {
  receivedSat: bigint;
  sentSat: bigint;
  /** How many transactions the address takes part in: 1 for one transaction, summed over a block. */
  txCount: number;
}

interface VinLike {
  txid?: string;
  address?: string;
  valueSat?: unknown;
}

interface VoutLike {
  valueSat?: unknown;
  scriptPubKey?: { addresses?: string[] };
}

export function normalizeSat(amountSat?: unknown, amountCoin?: number | null): bigint {
  if (amountSat !== undefined && amountSat !== null && amountSat !== '') {
    return satToBigInt(amountSat as Parameters<typeof satToBigInt>[0]);
  }
  return coinToSat(amountCoin);
}

export function canApplyAddressDeltas(vins: VinLike[], isCoinbase: boolean): boolean {
  if (isCoinbase) return true;
  return vins.every(
    (vin) =>
      !vin.txid ||
      (typeof vin.address === 'string' && vin.address.length > 0 && normalizeSat(vin.valueSat) > 0n)
  );
}

export function collectInvolvedAddresses(vins: VinLike[], vouts: VoutLike[]): string[] {
  const addresses = new Set<string>();
  for (const vin of vins) {
    if (typeof vin.address === 'string' && vin.address) addresses.add(vin.address);
  }
  for (const vout of vouts) {
    for (const address of vout.scriptPubKey?.addresses || []) {
      if (address) addresses.add(address);
    }
  }
  return Array.from(addresses);
}

export function collectAddressDeltas(
  vins: VinLike[],
  vouts: VoutLike[],
  isCoinbase: boolean
): Map<string, AddressDelta> {
  const addressMap = new Map<string, AddressDelta>();
  for (const vout of vouts) {
    const addresses = vout.scriptPubKey?.addresses;
    if (!addresses?.length) continue;
    const valueSat = normalizeSat(vout.valueSat);
    for (const address of addresses) {
      const entry = addressMap.get(address) || { receivedSat: 0n, sentSat: 0n, txCount: 1 };
      entry.receivedSat += valueSat;
      addressMap.set(address, entry);
    }
  }
  if (!isCoinbase) {
    for (const vin of vins) {
      const valueSat = normalizeSat(vin.valueSat);
      if (!vin.address || valueSat <= 0n) continue;
      const entry = addressMap.get(vin.address) || { receivedSat: 0n, sentSat: 0n, txCount: 1 };
      entry.sentSat += valueSat;
      addressMap.set(vin.address, entry);
    }
  }
  return addressMap;
}

export function mergeAddressDeltas(
  target: Map<string, AddressDelta>,
  source: Map<string, AddressDelta>
): void {
  for (const [address, delta] of source) {
    const current = target.get(address) || { receivedSat: 0n, sentSat: 0n, txCount: 0 };
    current.receivedSat += delta.receivedSat;
    current.sentSat += delta.sentSat;
    current.txCount += delta.txCount;
    target.set(address, current);
  }
}

function toDecimal128(amountSat: bigint): mongoose.Types.Decimal128 {
  return mongoose.Types.Decimal128.fromString(amountSat.toString());
}

export function buildAddressDeltaPipeline(
  address: string,
  delta: AddressDelta,
  blocktime: number
): Array<Record<string, unknown>> {
  const zeroDec = toDecimal128(0n);
  const netSatDec = toDecimal128(delta.receivedSat - delta.sentSat);
  const receivedDec = toDecimal128(delta.receivedSat);
  const sentDec = toDecimal128(delta.sentSat);
  return [
    {
      $set: {
        address: { $ifNull: ['$address', address] },
        balanceSat: { $add: [{ $ifNull: ['$balanceSat', zeroDec] }, netSatDec] },
        totalReceivedSat: { $add: [{ $ifNull: ['$totalReceivedSat', zeroDec] }, receivedDec] },
        totalSentSat: { $add: [{ $ifNull: ['$totalSentSat', zeroDec] }, sentDec] },
        txCount: { $add: [{ $ifNull: ['$txCount', 0] }, delta.txCount] },
        firstSeen: { $min: [{ $ifNull: ['$firstSeen', blocktime] }, blocktime] },
        lastSeen: { $max: [{ $ifNull: ['$lastSeen', 0] }, blocktime] },
      },
    },
  ];
}
