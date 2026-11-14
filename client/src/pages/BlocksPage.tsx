import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { HiOutlineCube } from 'react-icons/hi2';
import { fetchBlocksCursor, type BlocksCursor } from '../services/api';
import { formatAge, formatNumber, truncateHash } from '../utils/formatters';
import './PageStyles.css';
import { addressPath, blockPath } from '../utils/routes';

export default function BlocksPage() {
  const [cursorStack, setCursorStack] = useState<BlocksCursor[]>([]);
  const limit = 20;
  const cursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null;
  const page = cursorStack.length + 1;

  const { data, isLoading: loading } = useQuery({
    queryKey: ['blocks-cursor', limit, cursor?.cursorHeight ?? null],
    queryFn: () => fetchBlocksCursor(limit, cursor),
    placeholderData: keepPreviousData,
  });
  const blocks = data?.data || [];
  const nextCursorRaw = data?.cursor?.next?.cursorHeight;
  const nextCursorHeight =
    typeof nextCursorRaw === 'number'
      ? nextCursorRaw
      : typeof nextCursorRaw === 'string' && /^\d+$/.test(nextCursorRaw)
        ? Number.parseInt(nextCursorRaw, 10)
        : null;
  const hasMore = data?.cursor?.hasMore === true && nextCursorHeight != null;

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">
          <HiOutlineCube /> Latest DeFCoN Blocks
        </h1>
        <p className="page-subtitle">Browse all blocks on the DeFCoN blockchain</p>
      </div>

      <div className="card">
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading blocks...</div>
        ) : blocks.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            No blocks available yet.
          </div>
        ) : (
          <>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Height</th>
                    <th>Hash</th>
                    <th>Age</th>
                    <th>Txs</th>
                    <th>Difficulty</th>
                    <th>Value Out</th>
                    <th>Producer</th>
                  </tr>
                </thead>
                <tbody>
                  {blocks.map((block) => (
                    <tr key={block.height}>
                      <td>
                        <Link to={blockPath(block.height)} className="hash">
                          {formatNumber(block.height)}
                        </Link>
                      </td>
                      <td>
                        <Link to={blockPath(block.hash)} className="hash mono">
                          {truncateHash(block.hash, 12)}
                        </Link>
                      </td>
                      <td className="text-muted">{formatAge(block.time)}</td>
                      <td>{block.nTx}</td>
                      <td className="mono">{formatNumber(block.difficulty, 2)}</td>
                      <td className="mono">{formatNumber(block.totalValueOut || 0, 2)} DFCN</td>
                      {/* The staker (or premine miner) read from the chain; minedBy is the masternode the block paid. */}
                      <td className="mono">
                        {block.producer ? (
                          <Link to={addressPath(block.producer.address)} className="hash mono" title={block.producer.address}>
                            {truncateHash(block.producer.address, 12)}
                          </Link>
                        ) : (
                          <span className="text-muted">Unknown</span>
                        )}
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
                      nextCursorHeight != null ? [...prev, { cursorHeight: nextCursorHeight }] : prev
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
