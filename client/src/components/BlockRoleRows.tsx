import { Link } from 'react-router-dom';
import type { BlockProducer } from '@defcon/shared';
import { addressPath } from '../utils/routes';

type BlockRoles = { producer?: BlockProducer | null; masternodePayee?: string | null };

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function AddressValue({ address }: { address: unknown }) {
  return isAddress(address) ? (
    <Link to={addressPath(address)} className="hash">
      {address}
    </Link>
  ) : (
    <span className="text-muted">Unknown</span>
  );
}

/**
 * Detail rows for who made the block and, for a proof-of-stake block, which masternode its
 * reward paid. Anything the server could not read from the chain shows as "Unknown".
 */
export default function BlockRoleRows({ block }: { block: BlockRoles }) {
  const candidate = block.producer;
  const producer =
    candidate && isAddress(candidate.address) && (candidate.kind === 'staker' || candidate.kind === 'miner')
      ? candidate
      : null;
  const label = producer?.kind === 'staker' ? 'Staked by' : producer?.kind === 'miner' ? 'Mined by' : 'Producer';

  return (
    <>
      <div className="detail-row">
        <div className="detail-label">{label}</div>
        <div className="detail-value">
          <AddressValue address={producer?.address} />
        </div>
      </div>
      {producer?.kind === 'staker' && (
        <div className="detail-row">
          <div className="detail-label">Masternode payee</div>
          <div className="detail-value">
            <AddressValue address={block.masternodePayee} />
          </div>
        </div>
      )}
    </>
  );
}
