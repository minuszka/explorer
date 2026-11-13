import { Link } from 'react-router-dom';
import { HiOutlineClock, HiOutlineCube, HiOutlineDocumentText } from 'react-icons/hi2';
import type { TxView } from '../../types/api';
import { formatAge, formatBytes, formatCoin, formatDate, formatNumber } from '../../utils/formatters';
import { blockPath } from '../../utils/routes';
import FlowCard from './FlowCard';
import { classifyTransaction } from './flowModel';
import './flow.css';

/** The transaction page body: summary, every input and output, and the remaining details. */
export default function TransactionFlow({ tx }: { tx: TxView }) {
  const totalOut = typeof tx.totalValueOut === 'number' ? tx.totalValueOut : 0;
  const totalIn = typeof tx.totalValueIn === 'number' ? tx.totalValueIn : 0;
  const fee = typeof tx.fee === 'number' ? tx.fee : 0;
  const kind = classifyTransaction(tx);

  return (
    <>
      <div className="card searchv2-summary-strip">
        <div className="searchv2-summary-grid">
          <div className="searchv2-summary-item">
            <span className="searchv2-summary-label">Received</span>
            <strong className="searchv2-summary-value">
              <HiOutlineClock /> {formatAge(tx.blocktime)}
            </strong>
            <span className="searchv2-summary-subtle">{formatDate(tx.blocktime)}</span>
          </div>
          <div className="searchv2-summary-item">
            <span className="searchv2-summary-label">Total Transacted</span>
            <strong className="searchv2-summary-value">{formatCoin(totalOut)} DFCN</strong>
            <span className="searchv2-summary-subtle">Value out</span>
          </div>
          <div className="searchv2-summary-item">
            <span className="searchv2-summary-label">Total Input</span>
            <strong className="searchv2-summary-value">{formatCoin(totalIn)} DFCN</strong>
            <span className="searchv2-summary-subtle">Value in</span>
          </div>
          <div className="searchv2-summary-item">
            <span className="searchv2-summary-label">Total Fees</span>
            <strong className="searchv2-summary-value">{formatCoin(fee)} DFCN</strong>
            <span className="searchv2-summary-subtle">{formatNumber(tx.confirmations)} confirmations</span>
          </div>
        </div>
      </div>

      <FlowCard tx={tx} previewLimit={Number.POSITIVE_INFINITY} showScriptType />

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">
            <HiOutlineDocumentText /> Details
          </h2>
        </div>
        <div className="detail-grid">
          <div className="detail-row">
            <div className="detail-label">TX Hash</div>
            <div className="detail-value mono">{tx.txid}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">
              <HiOutlineCube /> Block
            </div>
            <div className="detail-value">
              <Link to={blockPath(tx.blockheight)} className="hash">
                #{formatNumber(tx.blockheight)}
              </Link>
            </div>
          </div>
          <div className="detail-row">
            <div className="detail-label">
              <HiOutlineClock /> Time
            </div>
            <div className="detail-value">
              {formatDate(tx.blocktime)} ({formatAge(tx.blocktime)})
            </div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Confirmations</div>
            <div className="detail-value">{formatNumber(tx.confirmations)}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Size</div>
            <div className="detail-value">{formatBytes(tx.size)}</div>
          </div>
          {tx.isDonation && (tx.donationAmount || 0) > 0 && (
            <div className="detail-row">
              <div className="detail-label">Donation Amount</div>
              <div className="detail-value value-highlight">{formatCoin(tx.donationAmount || 0)} DFCN</div>
            </div>
          )}
          <div className="detail-row">
            <div className="detail-label">Type</div>
            <div className="detail-value">
              <span className={`badge ${kind.tone !== 'neutral' ? kind.tone : ''}`}>{kind.label}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
