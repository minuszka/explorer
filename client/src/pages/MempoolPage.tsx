import { Link } from 'react-router-dom';
import {
  HiOutlineQueueList,
  HiOutlineClock,
  HiOutlineDocumentText,
} from 'react-icons/hi2';
import { useQuery } from '@tanstack/react-query';
import { fetchMempool, fetchStats } from '../services/api';
import { truncateHash, formatAge, formatBytes, formatCoin } from '../utils/formatters';
import './PageStyles.css';
import './MempoolPage.css';
import { txPath } from '../utils/routes';

export default function MempoolPage() {
  const mempoolQuery = useQuery({
    queryKey: ['mempool', 25],
    queryFn: () => fetchMempool(25),
  });
  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
  });
  const mempool = mempoolQuery.data;
  const loading = mempoolQuery.isLoading || mempoolQuery.isFetching;
  const error =
    mempoolQuery.error != null
      ? ((mempoolQuery.error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ||
          (mempoolQuery.error as Error)?.message ||
          'Failed to load mempool')
      : null;

  const info = mempool?.info;
  const txs = mempool?.txs || [];

  return (
    <div className="fade-in">
      <div className="mempool-hero">
        <h1 className="mempool-hero-title"><HiOutlineQueueList /> Mempool</h1>
        <p className="mempool-hero-subtitle">
          Unconfirmed transactions waiting to be included in a block
        </p>
      </div>

      <div className="mempool-stats">
        <div className="mempool-stat mempool-stat--queue">
          <div className="mempool-stat-label"><HiOutlineDocumentText /> Pending TXs</div>
          <div className="mempool-stat-value">{loading ? '…' : info?.size ?? 0}</div>
        </div>
        <div className="mempool-stat mempool-stat--size">
          <div className="mempool-stat-label"><HiOutlineQueueList /> Mempool Size</div>
          <div className="mempool-stat-value">{loading ? '…' : formatBytes(info?.bytes ?? 0)}</div>
        </div>
        <div className="mempool-stat mempool-stat--time">
          <div className="mempool-stat-label"><HiOutlineClock /> Est. Next Block</div>
          <div className="mempool-stat-value">
            {stats?.avgBlockTime ? `~${Math.round(stats.avgBlockTime)}s` : 'N/A'}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title"><HiOutlineDocumentText /> Pending Transactions</h2>
        </div>
        {error ? (
          <div className="mempool-error">{error}</div>
        ) : loading ? (
          <div className="mempool-loading">Loading mempool…</div>
        ) : txs.length === 0 ? (
          <div className="mempool-empty">Mempool is currently empty</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>TX Hash</th>
                  <th>Value</th>
                  <th>Fee</th>
                  <th>Size</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((tx) => (
                  <tr key={tx.txid}>
                    <td>
                      <Link to={txPath(tx.txid)} className="hash mono">
                        {truncateHash(tx.txid, 12)}
                      </Link>
                    </td>
                    <td className="mono">
                      {typeof tx.totalValueOut === 'number' ? `${formatCoin(tx.totalValueOut)} DFCN` : '-'}
                    </td>
                    <td className="mono text-muted">
                      {typeof tx.fee === 'number' ? `${formatCoin(tx.fee)} DFCN` : '-'}
                    </td>
                    <td>{typeof tx.size === 'number' ? formatBytes(tx.size) : '-'}</td>
                    <td className="text-muted">{typeof tx.time === 'number' ? formatAge(tx.time) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
