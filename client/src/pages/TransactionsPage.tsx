import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { HiOutlineBanknotes } from 'react-icons/hi2';
import { fetchTransactionsCursor, type TransactionsCursor } from '../services/api';
import { formatAge, formatCoin, formatNumber, truncateHash } from '../utils/formatters';
import './PageStyles.css';
import { blockPath, txPath } from '../utils/routes';

interface ListedTransaction {
  txid: string;
  blockheight: number;
  blocktime: number;
  totalValueOut: number;
  donationAmount?: number;
  fee: number;
  isCoinbase: boolean;
  isDonation?: boolean;
}

export default function TransactionsPage() {
  const [cursorStack, setCursorStack] = useState<TransactionsCursor[]>([]);
  const limit = 20;
  const cursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null;
  const page = cursorStack.length + 1;

  const { data, isLoading: loading } = useQuery({
    queryKey: ['txs-cursor', limit, cursor?.cursorBlockheight ?? null, cursor?.cursorId ?? null],
    queryFn: () => fetchTransactionsCursor(limit, cursor),
    placeholderData: keepPreviousData,
  });

  const txs = (data?.data || []) as ListedTransaction[];
  const nextBlockheightRaw = data?.cursor?.next?.cursorBlockheight;
  const nextCursorIdRaw = data?.cursor?.next?.cursorId;
  const nextCursorBlockheight =
    typeof nextBlockheightRaw === 'number'
      ? nextBlockheightRaw
      : typeof nextBlockheightRaw === 'string' && /^\d+$/.test(nextBlockheightRaw)
        ? Number.parseInt(nextBlockheightRaw, 10)
        : null;
  const nextCursorId = typeof nextCursorIdRaw === 'string' && nextCursorIdRaw ? nextCursorIdRaw : null;
  const hasMore = data?.cursor?.hasMore === true && nextCursorBlockheight != null && nextCursorId != null;

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">
          <HiOutlineBanknotes /> Latest DEFCON Transactions
        </h1>
        <p className="page-subtitle">Browse recent on-chain transactions</p>
      </div>

      <div className="card">
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading transactions...
          </div>
        ) : txs.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            No transactions found yet.
          </div>
        ) : (
          <>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>TX Hash</th>
                    <th>Block</th>
                    <th>Age</th>
                    <th>Value Out</th>
                    <th>Fee</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {txs.map((tx) => (
                    <tr key={tx.txid}>
                      <td>
                        <Link to={txPath(tx.txid)} className="hash mono">
                          {truncateHash(tx.txid, 12)}
                        </Link>
                        {tx.isDonation && (
                          <span className="badge donate" style={{ marginLeft: '0.45rem' }}>
                            ❤ Donate
                          </span>
                        )}
                      </td>
                      <td>
                        <Link to={blockPath(tx.blockheight)} className="hash">
                          #{formatNumber(tx.blockheight)}
                        </Link>
                      </td>
                      <td className="text-muted">{formatAge(tx.blocktime)}</td>
                      <td className="mono">
                        {tx.isDonation && (tx.donationAmount || 0) > 0 ? (
                          <>
                            ❤ Donated {formatCoin(tx.donationAmount || 0)} DFCN
                            <div className="text-muted" style={{ fontSize: '0.74rem', marginTop: '0.15rem' }}>
                              Total out: {formatCoin(tx.totalValueOut || 0)} DFCN
                            </div>
                          </>
                        ) : (
                          `${formatCoin(tx.totalValueOut || 0)} DFCN`
                        )}
                      </td>
                      <td className="mono text-muted">{formatCoin(tx.fee || 0)} DFCN</td>
                      <td>
                        {tx.isCoinbase ? <span className="badge">Block Reward</span> : <span className="text-muted">Regular</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(cursorStack.length > 0 || hasMore) && (
              <div className="pagination">
                <button onClick={() => setCursorStack((prev) => prev.slice(0, -1))} disabled={cursorStack.length === 0}>
                  &lsaquo;
                </button>
                <span style={{ padding: '0.5rem 1rem', color: 'var(--text-secondary)' }}>
                  Page {page}
                </span>
                <button
                  onClick={() =>
                    setCursorStack((prev) =>
                      nextCursorBlockheight != null && nextCursorId != null
                        ? [...prev, { cursorBlockheight: nextCursorBlockheight, cursorId: nextCursorId }]
                        : prev
                    )
                  }
                  disabled={!hasMore}
                >
                  &rsaquo;
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
