import { Link } from 'react-router-dom';
import { HiOutlineArrowRight, HiOutlineArrowsRightLeft, HiOutlineClock, HiOutlineCube } from 'react-icons/hi2';
import type { TxView } from '../../types/api';
import { formatAge, formatCoin, formatDate, formatNumber, truncateHash } from '../../utils/formatters';
import { addressPath, blockPath, txPath } from '../../utils/routes';
import {
  NET_TOLERANCE,
  buildInputEntries,
  buildOutputEntries,
  getDirectionSummary,
  type FlowEntry,
} from './flowModel';
import './flow.css';

const DEFAULT_PREVIEW_LIMIT = 4;

function FlowNode({ entry, showScriptType }: { entry: FlowEntry; showScriptType: boolean }) {
  const href = typeof entry.href === 'string' ? entry.href : entry.address ? addressPath(entry.address) : null;

  return (
    <div className={`searchv2-flow-node ${entry.isFocus ? 'focus' : ''}`}>
      <span className="searchv2-flow-node-amount">{formatCoin(entry.amount)} DFCN</span>
      {href ? (
        <Link
          to={href}
          className="searchv2-flow-node-address mono"
          title={entry.isFocus ? 'Open transaction details' : 'Open address'}
        >
          {entry.address ? truncateHash(entry.address, 14) : entry.label}
        </Link>
      ) : (
        <span className="searchv2-flow-node-address">{entry.label}</span>
      )}
      {/* Without an address the label already is the script type. */}
      {showScriptType && entry.address && entry.scriptType && (
        <span className="searchv2-flow-node-type">{entry.scriptType}</span>
      )}
      {entry.isFocus && <span className="searchv2-flow-node-tag">matched address</span>}
    </div>
  );
}

interface FlowCardProps {
  tx: TxView;
  /** The address whose page lists this transaction; its rows are highlighted and its net value shown. */
  focusAddress?: string;
  /** How many inputs and outputs to list before a "+N more" line; the transaction page lists all. */
  previewLimit?: number;
  /** Show each output's script type under its address, as the full transaction page does. */
  showScriptType?: boolean;
}

export default function FlowCard({
  tx,
  focusAddress,
  previewLimit = DEFAULT_PREVIEW_LIMIT,
  showScriptType = false,
}: FlowCardProps) {
  const inputs = buildInputEntries(tx, focusAddress);
  const outputs = buildOutputEntries(tx, focusAddress);
  const direction = getDirectionSummary(tx, focusAddress);
  const txTotalIn =
    typeof tx.totalValueIn === 'number'
      ? tx.totalValueIn
      : inputs.reduce((sum, input) => sum + input.amount, 0);
  const txTotalOut =
    typeof tx.totalValueOut === 'number'
      ? tx.totalValueOut
      : outputs.reduce((sum, output) => sum + output.amount, 0);
  const txFee = typeof tx.fee === 'number' ? tx.fee : Math.max(txTotalIn - txTotalOut, 0);
  const netSign = direction.net > NET_TOLERANCE ? '+' : direction.net < -NET_TOLERANCE ? '-' : '';

  const resolveFlowAddressHref = (address: string | null, isFocus: boolean): string | null => {
    if (!address) return null;
    if (isFocus && focusAddress) {
      // Already on this address page; open the transaction instead of a link to the same page.
      return txPath(tx.txid);
    }
    return addressPath(address);
  };

  return (
    <article className="card searchv2-flow-card">
      <div className="searchv2-flow-header">
        <div className="searchv2-flow-hashline">
          <HiOutlineArrowsRightLeft />
          <Link to={txPath(tx.txid)} className="hash mono">
            {truncateHash(tx.txid, 26)}
          </Link>
          {tx.isDonation && <span className="badge donate">Donate</span>}
        </div>

        <div className="searchv2-flow-meta">
          <span className={`badge ${direction.tone !== 'neutral' ? direction.tone : ''}`}>{direction.label}</span>
          <span className="searchv2-flow-meta-item">
            <HiOutlineCube />
            <Link to={blockPath(tx.blockheight)} className="hash">
              #{formatNumber(tx.blockheight)}
            </Link>
          </span>
          <span className="searchv2-flow-meta-item">
            <HiOutlineClock />
            {formatAge(tx.blocktime)} ({formatDate(tx.blocktime)})
          </span>
          <span className="searchv2-flow-meta-item">{formatNumber(tx.confirmations)} confirmations</span>
        </div>
      </div>

      <div className="searchv2-flow-grid">
        <div className="searchv2-flow-column">
          <p className="searchv2-flow-column-title">
            {formatNumber(inputs.length)} input{inputs.length === 1 ? '' : 's'} consumed
          </p>
          <div className="searchv2-flow-list">
            {inputs.slice(0, previewLimit).map((entry) => (
              <FlowNode
                key={entry.key}
                showScriptType={showScriptType}
                entry={{
                  ...entry,
                  href: resolveFlowAddressHref(entry.address, entry.isFocus),
                }}
              />
            ))}
          </div>
          {inputs.length > previewLimit && (
            <p className="searchv2-flow-more">+{formatNumber(inputs.length - previewLimit)} more inputs</p>
          )}
        </div>

        <div className="searchv2-flow-middle" aria-hidden="true">
          <span className="searchv2-flow-dot" />
          <span className="searchv2-flow-dot" />
          <span className="searchv2-flow-dot" />
          <HiOutlineArrowRight className="searchv2-flow-arrow" />
        </div>

        <div className="searchv2-flow-column">
          <p className="searchv2-flow-column-title">
            {formatNumber(outputs.length)} output{outputs.length === 1 ? '' : 's'} created
          </p>
          <div className="searchv2-flow-list">
            {outputs.slice(0, previewLimit).map((entry) => (
              <FlowNode
                key={entry.key}
                showScriptType={showScriptType}
                entry={{
                  ...entry,
                  href: resolveFlowAddressHref(entry.address, entry.isFocus),
                }}
              />
            ))}
          </div>
          {outputs.length > previewLimit && (
            <p className="searchv2-flow-more">
              +{formatNumber(outputs.length - previewLimit)} more outputs
            </p>
          )}
        </div>
      </div>

      <div className="searchv2-flow-footer">
        <span className="searchv2-flow-metric">
          Value transacted: <strong>{formatCoin(txTotalOut)} DFCN</strong>
        </span>
        <span className="searchv2-flow-metric">
          Total in: <strong>{formatCoin(txTotalIn)} DFCN</strong>
        </span>
        <span className="searchv2-flow-metric">
          Fee: <strong>{formatCoin(txFee)} DFCN</strong>
        </span>
        {focusAddress && (
          <span
            className={`searchv2-flow-metric searchv2-flow-net ${
              direction.net > NET_TOLERANCE ? 'positive' : direction.net < -NET_TOLERANCE ? 'negative' : 'flat'
            }`}
          >
            Net on this address: <strong>{netSign}{formatCoin(Math.abs(direction.net))} DFCN</strong>
          </span>
        )}
      </div>
    </article>
  );
}
