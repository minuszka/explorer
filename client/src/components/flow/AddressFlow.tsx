import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  HiOutlineArrowDownTray,
  HiOutlineArrowUpTray,
  HiOutlineArrowsRightLeft,
  HiOutlineDocumentText,
  HiOutlineWallet,
} from 'react-icons/hi2';
import { fetchAddress, fetchAddressTxs } from '../../services/api';
import type { TxView } from '../../types/api';
import { formatCoin, formatNumber } from '../../utils/formatters';
import StatePanel from '../ui/StatePanel';
import AddressTxRow from './AddressTxRow';
import { getErrorMessage, isNotFoundError, retryFailedRequestOnce } from './flowModel';
import './flow.css';

// One line per transaction, so a page holds more than the old full-size cards did.
const ADDRESS_TX_PAGE_SIZE = 20;

/**
 * The address page body. Mount it with `key={address}` so a different address starts on page 1
 * with no data carried over from the previous one.
 */
export default function AddressFlow({ address }: { address: string }) {
  const [page, setPage] = useState(1);

  const summaryQuery = useQuery({
    queryKey: ['address', address],
    queryFn: () => fetchAddress(address),
    retry: retryFailedRequestOnce,
  });
  const summary = summaryQuery.data ?? null;
  const summaryNotFound = isNotFoundError(summaryQuery.error);
  const summaryError =
    summaryQuery.error != null && !summaryNotFound
      ? getErrorMessage(summaryQuery.error, 'Address details could not be loaded.')
      : null;

  const txsQuery = useQuery({
    queryKey: ['address-txs', address, page, ADDRESS_TX_PAGE_SIZE],
    queryFn: () => fetchAddressTxs(address, page, ADDRESS_TX_PAGE_SIZE),
  });
  const txs = (txsQuery.data?.data || []) as TxView[];
  const pages = txsQuery.data?.pagination?.pages || 1;
  const txsLoading = txsQuery.isPending || txsQuery.isFetching;
  const txsError =
    txsQuery.error != null ? getErrorMessage(txsQuery.error, 'Address transactions could not be loaded.') : null;
  const txTotal = summary?.txCount ?? txsQuery.data?.pagination?.total ?? txs.length;

  // Neither a summary nor a single indexed transaction: the explorer has never seen this address.
  if (summaryNotFound && !txsQuery.isPending && !txsError && txs.length === 0) {
    return (
      <StatePanel
        title="Address not found"
        description="This address has no transactions in the explorer's index yet."
        action={<Link to="/richlist" className="btn btn-secondary">Rich List</Link>}
      />
    );
  }

  return (
    <>
      {summaryQuery.isPending && <StatePanel title="Loading address..." />}

      {summaryError && (
        <StatePanel tone="danger" title="Address details could not be loaded" description={summaryError} />
      )}

      {summary && (
        <div className="grid-stats searchv2-address-stats">
          <article className="stat-card">
            <div className="stat-label">
              <HiOutlineWallet /> Balance
            </div>
            <div className="stat-value">{formatCoin(summary.balance)}</div>
            <div className="stat-change">DFCN</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">
              <HiOutlineArrowDownTray /> Total Received
            </div>
            <div className="stat-value searchv2-positive">{formatCoin(summary.totalReceived)}</div>
            <div className="stat-change">DFCN</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">
              <HiOutlineArrowUpTray /> Total Sent
            </div>
            <div className="stat-value searchv2-negative">{formatCoin(summary.totalSent)}</div>
            <div className="stat-change">DFCN</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">
              <HiOutlineDocumentText /> Transactions
            </div>
            <div className="stat-value">{formatNumber(summary.txCount)}</div>
          </article>
        </div>
      )}

      <div className="card searchv2-address-flows">
        <div className="card-header">
          <h2 className="card-title">
            <HiOutlineArrowsRightLeft /> Transactions
          </h2>
          {!txsQuery.isPending && !txsError && (
            <span className="searchv2-address-total">
              {formatNumber(txTotal)} total transaction{txTotal === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {summaryNotFound && (
          <div className="searchv2-inline-state">
            Address summary is not indexed yet. Showing transactions where this address appears.
          </div>
        )}

        {txsLoading && <div className="searchv2-inline-state">Loading transactions for this address...</div>}

        {!txsLoading && txsError && <div className="searchv2-inline-state">{txsError}</div>}

        {!txsLoading && !txsError && txs.length === 0 && (
          <div className="searchv2-inline-state">No transactions found for this address yet.</div>
        )}

        {!txsLoading && !txsError && txs.length > 0 && (
          <>
            <ul className="address-tx-rows">
              {txs.map((tx) => (
                <AddressTxRow key={tx.txid} tx={tx} address={address} />
              ))}
            </ul>

            {pages > 1 && (
              <div className="pagination">
                <button onClick={() => setPage((current) => current - 1)} disabled={page <= 1}>
                  &lsaquo;
                </button>
                <span className="searchv2-pagination-label">
                  Page {formatNumber(page)} of {formatNumber(pages)}
                </span>
                <button onClick={() => setPage((current) => current + 1)} disabled={page >= pages}>
                  &rsaquo;
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
