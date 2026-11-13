/** Who made a block: the staker of a proof-of-stake block, or the miner of a premine block. */
export interface BlockProducer {
  address: string;
  kind: 'staker' | 'miner';
}

export interface IBlock {
  hash: string;
  height: number;
  confirmations: number;
  size: number;
  version: number;
  merkleroot: string;
  time: number;
  mediantime: number;
  nonce: number;
  bits: string;
  difficulty: number;
  chainwork: string;
  nTx: number;
  previousblockhash?: string;
  nextblockhash?: string;
  /** The first address the coinbase pays: the masternode in a proof-of-stake block, not its producer. */
  minedBy?: string;
  /** Block detail only: the producer read from the coinstake (or a premine coinbase); null when unknown. */
  producer?: BlockProducer | null;
  /** Block detail only: the one address the coinbase of a proof-of-stake block pays; null when unknown. */
  masternodePayee?: string | null;
  rewardSat: number | string;
  totalValueOutSat: number | string;
  txids: string[];
  // Derived coin-denominated fields for API responses.
  reward?: number;
  totalValueOut?: number;
}
