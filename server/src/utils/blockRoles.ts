/**
 * Who made a block and who the block reward paid, read from the block's first two transactions.
 *
 * DeFCoN blocks since the premine are proof of stake. Their coinbase has an empty first output and
 * then pays the masternode; the second transaction is the coinstake, in which the staker spends its
 * own coins and gets them back with the stake reward. The premine blocks were mined: their
 * coinbase pays the miner directly. `minedBy` keeps the first address the coinbase pays, which in a
 * proof-of-stake block is the masternode, not the block's producer.
 *
 * Anything that does not match these shapes exactly is unknown (null), never a guess.
 */

export type BlockProducerKind = 'staker' | 'miner';

export interface BlockProducer {
  address: string;
  kind: BlockProducerKind;
}

export interface BlockRoles {
  producer: BlockProducer | null;
  /** The one address the coinbase of a proof-of-stake block pays; null when it pays none or several. */
  masternodePayee: string | null;
}

type RoleOutput = { valueSat?: unknown; scriptPubKey?: { addresses?: unknown; hex?: unknown } | null } | null | undefined;

export interface RoleTx {
  txid?: unknown;
  isCoinbase?: unknown;
  vin?: Array<{ address?: unknown } | null | undefined> | null;
  vout?: RoleOutput[] | null;
}

const unknownRoles = (): BlockRoles => ({ producer: null, masternodePayee: null });

/** An amount in satoshis, or null when it is missing or not a whole number of satoshis. */
function exactSat(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  const text =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof (value as { toString(): unknown }).toString === 'function'
        ? String(value)
        : null;
  if (text == null) return null;
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? BigInt(trimmed) : null;
}

function addressesOf(output: RoleOutput): string[] | null {
  const addresses = output?.scriptPubKey?.addresses;
  if (addresses == null) return [];
  if (!Array.isArray(addresses)) return null;
  return addresses.every((address) => typeof address === 'string' && address !== '') ? (addresses as string[]) : null;
}

/**
 * The marker that opens a coinstake or a PoS coinbase: worth exactly nothing, paying no address, and
 * with an empty script. A zero-value OP_RETURN note has a script, so it is not a marker; an output
 * stored without its script is unknown, so not a marker either.
 */
function isEmptyMarker(output: RoleOutput): boolean {
  const addresses = addressesOf(output);
  return exactSat(output?.valueSat) === 0n && addresses != null && addresses.length === 0 && output?.scriptPubKey?.hex === '';
}

/** The staker of a coinstake, or null when the transaction does not have that exact shape. */
export function stakerOf(tx: RoleTx | null | undefined): string | null {
  if (!tx || tx.isCoinbase === true) return null;
  const vin = Array.isArray(tx.vin) ? tx.vin : [];
  const vout = Array.isArray(tx.vout) ? tx.vout : [];
  if (vin.length === 0 || vout.length < 2 || !isEmptyMarker(vout[0])) return null;

  // Every input comes from one address: the staker's own coins.
  const staker = vin[0]?.address;
  if (typeof staker !== 'string' || staker === '') return null;
  if (!vin.every((input) => input?.address === staker)) return null;

  // And the stake comes back to that same address.
  const returned = vout.slice(1).some((output) => {
    const addresses = addressesOf(output);
    const value = exactSat(output?.valueSat);
    return addresses?.length === 1 && addresses[0] === staker && value != null && value > 0n;
  });
  return returned ? staker : null;
}

/** The single address a transaction's valued outputs pay, or null when they pay none, several, or unclear ones. */
function soleRecipient(tx: RoleTx): string | null {
  const vout = Array.isArray(tx.vout) ? tx.vout : [];
  let recipient: string | null = null;
  for (const output of vout) {
    const value = exactSat(output?.valueSat);
    if (value == null) return null;
    if (value === 0n) continue;
    const addresses = addressesOf(output);
    if (addresses == null || addresses.length !== 1) return null;
    if (recipient != null && recipient !== addresses[0]) return null;
    recipient = addresses[0];
  }
  return recipient;
}

/**
 * Reads the producer and the masternode payee of a block from its first two transactions.
 * `txids` is the block's transaction list in block order; `txs` may hold them in any order.
 */
export function blockRoles(txids: unknown, txs: RoleTx[]): BlockRoles {
  if (!Array.isArray(txids) || txids.length === 0) return unknownRoles();
  const byId = new Map(txs.filter((tx) => typeof tx?.txid === 'string').map((tx) => [tx.txid as string, tx]));
  const coinbase = byId.get(txids[0]);
  if (!coinbase || coinbase.isCoinbase !== true) return unknownRoles();

  const staker = txids.length > 1 ? stakerOf(byId.get(txids[1])) : null;
  const coinbaseOutputs = Array.isArray(coinbase.vout) ? coinbase.vout : [];

  if (staker) {
    // A proof-of-stake coinbase opens with the empty marker; what it then pays goes to the masternode.
    const masternodePayee = coinbaseOutputs.length > 0 && isEmptyMarker(coinbaseOutputs[0]) ? soleRecipient(coinbase) : null;
    return { producer: { address: staker, kind: 'staker' }, masternodePayee };
  }

  // A mined block: no coinstake, and the coinbase pays its reward straight to one address.
  const first = coinbaseOutputs[0];
  const firstValue = exactSat(first?.valueSat);
  if (txids.length > 1 && byId.get(txids[1]) == null) return unknownRoles(); // second transaction not indexed
  if (firstValue != null && firstValue > 0n) {
    const miner = soleRecipient(coinbase);
    if (miner) return { producer: { address: miner, kind: 'miner' }, masternodePayee: null };
  }
  return unknownRoles();
}
