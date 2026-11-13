import type { TxView } from '../../types/api';

export const NET_TOLERANCE = 0.0000001;
const HEX64_RE = /^[a-fA-F0-9]{64}$/;
const BASE58_RE = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

type ApiErrorShape = {
  response?: {
    status?: number;
    data?: {
      error?: {
        message?: string;
      };
    };
  };
};

export interface FlowEntry {
  key: string;
  amount: number;
  address: string | null;
  href?: string | null;
  label: string;
  /** The output's script type (pubkeyhash, pubkey, ...); null for inputs. */
  scriptType: string | null;
  isFocus: boolean;
}

type RuntimeVin = {
  address?: unknown;
  coinbase?: unknown;
  value?: unknown;
};

type RuntimeVout = {
  value?: unknown;
  scriptPubKey?: {
    addresses?: unknown;
    type?: unknown;
  };
};

export function getErrorMessage(error: unknown, fallback: string): string {
  const apiError = error as ApiErrorShape;
  const apiMessage = apiError?.response?.data?.error?.message;
  if (typeof apiMessage === 'string' && apiMessage.trim()) {
    return apiMessage;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

/** The HTTP status the API answered with; undefined when no answer arrived. */
export function errorStatus(error: unknown): number | undefined {
  return (error as ApiErrorShape)?.response?.status;
}

/** True only when the API answered that the object does not exist, not for a failed request. */
export function isNotFoundError(error: unknown): boolean {
  return errorStatus(error) === 404;
}

/**
 * React Query retry rule: a failed request is tried once more, but an answer about the request
 * itself (400 invalid, 404 not found) will not change on a retry.
 */
export function retryFailedRequestOnce(failureCount: number, error: unknown): boolean {
  const status = errorStatus(error);
  const answeredAboutRequest = status !== undefined && status >= 400 && status < 500;
  return !answeredAboutRequest && failureCount < 1;
}

export function looksLikeTxid(value: string): boolean {
  return HEX64_RE.test(value);
}

export function looksLikeDfcnAddress(value: string): boolean {
  return value.length >= 26 && value.length <= 35 && value.startsWith('D') && BASE58_RE.test(value);
}

export function toAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getVinList(tx: TxView): RuntimeVin[] {
  const vin = (tx as { vin?: unknown }).vin;
  return Array.isArray(vin) ? (vin as RuntimeVin[]) : [];
}

function getVoutList(tx: TxView): RuntimeVout[] {
  const vout = (tx as { vout?: unknown }).vout;
  return Array.isArray(vout) ? (vout as RuntimeVout[]) : [];
}

function getVoutAddresses(vout: RuntimeVout): string[] {
  const addresses = vout?.scriptPubKey?.addresses;
  return Array.isArray(addresses) ? addresses.filter((address): address is string => typeof address === 'string') : [];
}

function getVoutScriptType(vout: RuntimeVout): string | null {
  const type = vout?.scriptPubKey?.type;
  return typeof type === 'string' && type.trim() ? type : null;
}

function getVoutLabel(vout: RuntimeVout, address: string | null): string {
  if (address) return address;
  return getVoutScriptType(vout) ?? 'Unknown output';
}

export function buildInputEntries(tx: TxView, focusAddress?: string): FlowEntry[] {
  return getVinList(tx).map((vin, index) => {
    const amount = toAmount(vin.value);
    const hasAddress = typeof vin.address === 'string' && vin.address.length > 0;
    const isCoinbase = Boolean(vin.coinbase) || tx.isCoinbase;

    if (hasAddress) {
      const address = vin.address as string;
      return {
        key: `in-${index}-${address}`,
        amount,
        address,
        label: address,
        scriptType: null,
        isFocus: Boolean(focusAddress && focusAddress === address),
      };
    }

    return {
      key: `in-${index}-coinbase`,
      amount,
      address: null,
      label: isCoinbase ? 'Coinbase / Block reward' : 'Unknown input',
      scriptType: null,
      isFocus: false,
    };
  });
}

export function buildOutputEntries(tx: TxView, focusAddress?: string): FlowEntry[] {
  return getVoutList(tx).map((vout, index) => {
    const amount = toAmount(vout.value);
    const addresses = getVoutAddresses(vout);
    const address = addresses.length > 0 ? addresses[0] : null;
    const label = getVoutLabel(vout, address);
    const isFocus = Boolean(focusAddress && addresses.includes(focusAddress));

    return {
      key: `out-${index}-${label}`,
      amount,
      address,
      label,
      scriptType: getVoutScriptType(vout),
      isFocus,
    };
  });
}

export type TxKind = 'reward' | 'stake' | 'protocol' | 'transfer';
export type TxTone = 'success' | 'warning' | 'error' | 'neutral';

export interface TxClassification {
  kind: TxKind;
  /** The one label both the transaction page and an address page show for this transaction. */
  label: string;
  tone: TxTone;
  /** Only with an address: what that address put in and got back, and the difference. */
  sent: number;
  received: number;
  net: number;
}

function isCoinbaseTx(tx: TxView): boolean {
  return tx.isCoinbase === true || getVinList(tx).some((vin) => Boolean(vin.coinbase));
}

/**
 * A proof-of-stake transaction spends coins from an address and starts with an empty, zero-value
 * output that has no address and the `nonstandard` type. A block reward has the same empty first
 * output but spends nothing. A null-data output (`nulldata`) is not that marker, and an output whose
 * type is unknown proves nothing, so without it the transaction stays a transfer.
 */
function isStakeTx(tx: TxView): boolean {
  const vin = getVinList(tx);
  const vout = getVoutList(tx);
  const spendsFromAddress = vin.some((input) => typeof input.address === 'string' && input.address.length > 0);
  if (!spendsFromAddress || vout.length < 2) return false;
  const marker = vout[0];
  const type = getVoutScriptType(marker);
  return toAmount(marker.value) === 0 && getVoutAddresses(marker).length === 0 && type === 'nonstandard';
}

/** No inputs and no outputs at all: a special transaction the chain itself carries (for example a quorum commitment). */
function isProtocolTx(tx: TxView): boolean {
  const vin = (tx as { vin?: unknown }).vin;
  const vout = (tx as { vout?: unknown }).vout;
  return Array.isArray(vin) && vin.length === 0 && Array.isArray(vout) && vout.length === 0;
}

const KIND_LABEL: Record<Exclude<TxKind, 'transfer'>, { label: string; tone: TxTone }> = {
  reward: { label: 'Reward', tone: 'success' },
  stake: { label: 'Stake', tone: 'success' },
  protocol: { label: 'Protocol', tone: 'neutral' },
};

/**
 * Sorts a transaction into reward, stake, protocol or transfer from its own fields only, and, for a
 * transfer seen from an address, into received, sent or self. Anything it cannot place stays "Transfer".
 */
export function classifyTransaction(tx: TxView, focusAddress?: string): TxClassification {
  const sent = focusAddress
    ? getVinList(tx).reduce((sum, vin) => (vin.address === focusAddress ? sum + toAmount(vin.value) : sum), 0)
    : 0;
  const received = focusAddress
    ? getVoutList(tx).reduce((sum, vout) => (getVoutAddresses(vout).includes(focusAddress) ? sum + toAmount(vout.value) : sum), 0)
    : 0;
  const net = received - sent;
  const amounts = { sent, received, net };

  const kind: TxKind = isCoinbaseTx(tx) ? 'reward' : isStakeTx(tx) ? 'stake' : isProtocolTx(tx) ? 'protocol' : 'transfer';
  if (kind !== 'transfer') return { kind, ...KIND_LABEL[kind], ...amounts };
  if (!focusAddress) return { kind, label: 'Transfer', tone: 'neutral', ...amounts };

  const didSend = sent > NET_TOLERANCE;
  const didReceive = received > NET_TOLERANCE;
  // Every output that carries value goes to this address alone: nothing left it except the fee.
  // Only an output worth exactly nothing (a stake marker, an OP_RETURN note) may go elsewhere; even
  // one satoshi to an output without an address, or to one shared with another address, is not that.
  const onlyToSelf = getVoutList(tx).every((vout) => {
    if (vout.value != null && toAmount(vout.value) === 0) return true;
    const addresses = getVoutAddresses(vout);
    return addresses.length === 1 && addresses[0] === focusAddress;
  });
  if (didSend && didReceive && onlyToSelf) return { kind, label: 'Self', tone: 'warning', ...amounts };
  if (didSend && net < -NET_TOLERANCE) return { kind, label: 'Sent', tone: 'error', ...amounts };
  if (didReceive && net > NET_TOLERANCE) return { kind, label: 'Received', tone: 'success', ...amounts };
  return { kind, label: 'Transfer', tone: 'neutral', ...amounts };
}
