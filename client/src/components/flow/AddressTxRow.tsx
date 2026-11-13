import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { HiOutlineChevronDown } from 'react-icons/hi2';
import type { TxView } from '../../types/api';
import { formatCoin, formatNumber, truncateHash } from '../../utils/formatters';
import { blockPath, txPath } from '../../utils/routes';
import TimeText from '../ui/TimeText';
import FlowCard from './FlowCard';
import { NET_TOLERANCE, classifyTransaction } from './flowModel';
import './flow.css';

/** One transaction on an address page: a single line with what it did to the address, opening its full flow below. */
export default function AddressTxRow({ tx, address }: { tx: TxView; address: string }) {
  const [open, setOpen] = useState(false);
  const flowId = useId();
  const kind = classifyTransaction(tx, address);
  const direction = kind.net > NET_TOLERANCE ? 'positive' : kind.net < -NET_TOLERANCE ? 'negative' : 'flat';
  const sign = direction === 'positive' ? '+' : direction === 'negative' ? '-' : '';
  const shortTxid = truncateHash(tx.txid, 8);

  return (
    <li className={`address-tx-row${open ? ' open' : ''}`}>
      <div className="address-tx-row-line">
        <span className="address-tx-row-kind">
          <span className={`badge ${kind.tone !== 'neutral' ? kind.tone : ''}`}>{kind.label}</span>
          {tx.isDonation && <span className="badge donate">Donate</span>}
        </span>
        <Link to={txPath(tx.txid)} className="hash mono address-tx-row-txid" title={tx.txid}>
          {shortTxid}
        </Link>
        <Link to={blockPath(tx.blockheight)} className="hash address-tx-row-block">
          #{formatNumber(tx.blockheight)}
        </Link>
        <span className="address-tx-row-time">
          <TimeText value={tx.blocktime * 1000} />
        </span>
        <span className={`address-tx-row-amount ${direction}`}>
          {sign}
          {formatCoin(Math.abs(kind.net))} DFCN
        </span>
        <button
          type="button"
          className="address-tx-row-toggle"
          aria-expanded={open}
          aria-controls={flowId}
          aria-label={`${open ? 'Hide' : 'Show'} the flow of transaction ${shortTxid}`}
          onClick={() => setOpen((current) => !current)}
        >
          <HiOutlineChevronDown aria-hidden="true" />
        </button>
      </div>
      <div id={flowId} className="address-tx-row-flow" hidden={!open}>
        {open && <FlowCard tx={tx} focusAddress={address} showHeader={false} />}
      </div>
    </li>
  );
}
