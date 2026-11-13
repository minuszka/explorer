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

export interface DirectionSummary {
  label: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
  sent: number;
  received: number;
  net: number;
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

export function getDirectionSummary(tx: TxView, focusAddress?: string): DirectionSummary {
  if (!focusAddress) {
    return {
      label: tx.isCoinbase ? 'Block Reward' : 'Transfer',
      tone: tx.isCoinbase ? 'success' : 'neutral',
      sent: 0,
      received: 0,
      net: 0,
    };
  }

  const sent = getVinList(tx).reduce((sum, vin) => {
    if (vin.address !== focusAddress) return sum;
    return sum + toAmount(vin.value);
  }, 0);

  const received = getVoutList(tx).reduce((sum, vout) => {
    const addresses = getVoutAddresses(vout);
    if (!addresses.includes(focusAddress)) return sum;
    return sum + toAmount(vout.value);
  }, 0);

  const net = received - sent;

  if (sent > NET_TOLERANCE && received > NET_TOLERANCE) {
    if (net > NET_TOLERANCE) {
      return { label: 'Self / Stake In', tone: 'success', sent, received, net };
    }
    if (net < -NET_TOLERANCE) {
      return { label: 'Self / Change Out', tone: 'warning', sent, received, net };
    }
    return { label: 'Self Transfer', tone: 'warning', sent, received, net };
  }

  if (received > NET_TOLERANCE) {
    return { label: 'Received', tone: 'success', sent, received, net };
  }

  if (sent > NET_TOLERANCE) {
    return { label: 'Sent', tone: 'error', sent, received, net };
  }

  return {
    label: tx.isCoinbase ? 'Reward' : 'Observed',
    tone: tx.isCoinbase ? 'success' : 'neutral',
    sent,
    received,
    net,
  };
}
