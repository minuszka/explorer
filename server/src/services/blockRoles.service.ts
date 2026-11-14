import { Block } from '../models/Block';
import { Transaction } from '../models/Transaction';
import { blockRoles, stakerOf, type BlockProducer, type BlockRoles, type RoleTx } from '../utils/blockRoles';

const ROLE_TX_PROJECTION = {
  _id: 0,
  txid: 1,
  isCoinbase: 1,
  'vin.address': 1,
  'vout.valueSat': 1,
  'vout.scriptPubKey.addresses': 1,
  'vout.scriptPubKey.hex': 1,
};

/** The producer and masternode payee of one block, from its first two indexed transactions. */
export async function loadBlockRoles(txids: unknown): Promise<BlockRoles> {
  if (!Array.isArray(txids) || txids.length === 0) return blockRoles(txids, []);
  const firstTwo = txids.slice(0, 2).filter((txid): txid is string => typeof txid === 'string');
  const txs = await Transaction.find({ txid: { $in: firstTwo } })
    .select(ROLE_TX_PROJECTION)
    .lean<RoleTx[]>();
  return blockRoles(txids, txs);
}

/**
 * The producer of each listed block, from the blocks' first two transactions in one query. Each
 * block needs its first two `txids` (a `{ txids: { $slice: 2 } }` projection is enough); the list
 * comes back in the same order, without `txids`, with `producer` (null when unknown).
 */
export async function withBlockProducers<T extends { txids?: unknown }>(
  blocks: T[]
): Promise<Array<T & { producer: BlockProducer | null }>> {
  const firstTwo = blocks.flatMap((block) =>
    Array.isArray(block.txids) ? block.txids.slice(0, 2).filter((txid): txid is string => typeof txid === 'string') : []
  );
  const txs = firstTwo.length > 0
    ? await Transaction.find({ txid: { $in: firstTwo } }).select(ROLE_TX_PROJECTION).lean<RoleTx[]>()
    : [];
  return blocks.map(({ txids, ...block }) => ({ ...block, producer: blockRoles(txids, txs).producer }) as T & { producer: BlockProducer | null });
}

/**
 * How many different addresses staked a block since `sinceTime` (unix seconds), read from each
 * block's coinstake. Undefined when no block in the window has an identifiable staker.
 */
export async function countStakersSince(sinceTime: number): Promise<number | undefined> {
  const blocks = await Block.find({ time: { $gte: sinceTime } })
    .select({ _id: 0, height: 1, txids: { $slice: 2 } })
    .lean<Array<{ txids?: unknown }>>();
  const coinstakeIds = blocks
    .map((block) => (Array.isArray(block.txids) ? block.txids[1] : undefined))
    .filter((txid): txid is string => typeof txid === 'string');
  if (coinstakeIds.length === 0) return undefined;

  const txs = await Transaction.find({ txid: { $in: coinstakeIds } })
    .select(ROLE_TX_PROJECTION)
    .lean<RoleTx[]>();
  const stakers = new Set<string>();
  for (const tx of txs) {
    const staker = stakerOf(tx);
    if (staker) stakers.add(staker);
  }
  return stakers.size > 0 ? stakers.size : undefined;
}
