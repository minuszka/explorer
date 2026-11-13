import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  HiOutlineCube,
  HiOutlineChevronLeft,
  HiOutlineChevronRight,
  HiOutlineClock,
  HiOutlineArrowTrendingUp,
} from 'react-icons/hi2';
import { fetchBlock, fetchBlockTxs } from '../services/api';
import BlockRoleRows from '../components/BlockRoleRows';
import { formatNumber, truncateHash, formatAge, formatDate, formatBytes, formatCoin } from '../utils/formatters';
import { blockPath, txPath } from '../utils/routes';
import CopyButton from '../components/ui/CopyButton';
import './PageStyles.css';

export default function BlockDetailPage() {
  const { hashOrHeight } = useParams();
  // The previous/next links stay on this route. A new block gets a fresh view, so the previous
  // block's details or transactions never show under the new block's address while it loads.
  return <BlockDetailView key={hashOrHeight ?? ''} hashOrHeight={hashOrHeight} />;
}

function BlockDetailView({ hashOrHeight }: { hashOrHeight: string | undefined }) {
  const blockKey = hashOrHeight || '0';
  const [page, setPageState] = useState(1);
  const limit = 20;
  const setPage = (nextPage: number) => setPageState(Math.max(1, nextPage));

  const { data: block, isLoading: loading, error } = useQuery({
    queryKey: ['block', hashOrHeight],
    queryFn: () => fetchBlock(blockKey),
    enabled: !!hashOrHeight,
  });
  const { data: txsData, isLoading: txsLoading } = useQuery({
    queryKey: ['block-txs', hashOrHeight, page, limit],
    queryFn: () => fetchBlockTxs(blockKey, page, limit),
    enabled: !!hashOrHeight,
  });
  const txs = txsData?.data || [];
  const pagination = txsData?.pagination || { page: 1, pages: 1, total: block?.nTx || 0 };

  if (loading) {
    return (
      <div className="fade-in">
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading block...</div>
      </div>
    );
  }

  if (error || !block) {
    return (
      <div className="fade-in">
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <h2>Block Not Found</h2>
          <p className="text-muted">Block "{hashOrHeight}" was not found. It may not be synced yet.</p>
          <Link to="/blocks" className="btn btn-secondary" style={{ marginTop: '1rem' }}>Browse Blocks</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      {/* The title starts at the left edge, as on every other page; the neighbouring blocks follow it. */}
      <div className="page-header block-header">
        <h1 className="page-title">
          <HiOutlineCube /> Block #{formatNumber(block.height)}
        </h1>
        {(block.height > 0 || block.nextblockhash) && (
          <nav className="block-nav" aria-label="Neighbouring blocks">
            {block.height > 0 && (
              <Link to={blockPath(block.height - 1)} className="btn btn-sm btn-secondary">
                <HiOutlineChevronLeft /> Block #{formatNumber(block.height - 1)}
              </Link>
            )}
            {block.nextblockhash && (
              <Link to={blockPath(block.height + 1)} className="btn btn-sm btn-secondary">
                Block #{formatNumber(block.height + 1)} <HiOutlineChevronRight />
              </Link>
            )}
          </nav>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title"><HiOutlineCube /> Block Details</h2>
          <span className="badge success">{block.confirmations} Confirmations</span>
        </div>
        <div className="detail-grid">
          <div className="detail-row">
            <div className="detail-label">Hash</div>
            <div className="detail-value detail-value-copy">
              <span className="detail-value-id">{block.hash}</span>
              <CopyButton value={block.hash} label="block hash" />
            </div>
          </div>
          <div className="detail-row">
            <div className="detail-label"><HiOutlineClock /> Timestamp</div>
            <div className="detail-value">{formatDate(block.time)} ({formatAge(block.time)})</div>
          </div>
          <BlockRoleRows block={block} />
          <div className="detail-row">
            <div className="detail-label">Height</div>
            <div className="detail-value">{formatNumber(block.height)}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Transactions</div>
            <div className="detail-value">{block.nTx}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label"><HiOutlineArrowTrendingUp /> Difficulty</div>
            <div className="detail-value">{formatNumber(block.difficulty, 4)}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Size</div>
            <div className="detail-value">{formatBytes(block.size)}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Version</div>
            <div className="detail-value">0x{block.version.toString(16)}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Merkle Root</div>
            <div className="detail-value" style={{ fontSize: '0.8rem' }}>{block.merkleroot}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Nonce</div>
            <div className="detail-value">{formatNumber(block.nonce)}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Bits</div>
            <div className="detail-value">{block.bits}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Block Reward</div>
            <div className="detail-value value-highlight">{formatCoin(Number(block.reward || 0))} DFCN</div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div className="card-header">
          <h2 className="card-title">Transactions ({block.nTx})</h2>
        </div>
        {txsLoading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading transactions...
          </div>
        ) : txs.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            No transactions found in this block.
          </div>
        ) : (
          <>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>TX Hash</th>
                    <th>Value Out</th>
                    <th>Fee</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {txs.map((tx) => (
                    <tr key={tx.txid}>
                      <td>
                        <Link to={txPath(tx.txid)} className="hash mono">
                          {truncateHash(tx.txid, 16)}
                        </Link>
                        {tx.isDonation && (
                          <span className="badge donate" style={{ marginLeft: '0.45rem' }}>
                            ❤ Donate
                          </span>
                        )}
                      </td>
                      <td className="mono">
                        {tx.isDonation && (tx.donationAmount || 0) > 0 ? (
                          <>
                            ❤ Donated {formatCoin(Number(tx.donationAmount || 0))} DFCN
                            <div className="text-muted" style={{ fontSize: '0.74rem', marginTop: '0.15rem' }}>
                              Total out: {formatCoin(Number(tx.totalValueOut || 0))} DFCN
                            </div>
                          </>
                        ) : (
                          `${formatCoin(Number(tx.totalValueOut || 0))} DFCN`
                        )}
                      </td>
                      <td className="mono text-muted">{formatCoin(Number(tx.fee || 0))} DFCN</td>
                      <td>{formatBytes(tx.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pagination.pages > 1 && (
              <div className="pagination">
                <button onClick={() => setPage(1)} disabled={page <= 1}>
                  &laquo;
                </button>
                <button onClick={() => setPage(page - 1)} disabled={page <= 1}>
                  &lsaquo;
                </button>
                <span style={{ padding: '0.5rem 1rem', color: 'var(--text-secondary)' }}>
                  Page {page} of {pagination.pages}
                </span>
                <button onClick={() => setPage(page + 1)} disabled={page >= pagination.pages}>
                  &rsaquo;
                </button>
                <button onClick={() => setPage(pagination.pages)} disabled={page >= pagination.pages}>
                  &raquo;
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
