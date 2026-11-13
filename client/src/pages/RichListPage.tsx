import { useState } from 'react';
import { Link } from 'react-router-dom';
import { HiOutlineListBullet, HiOutlineTrophy } from 'react-icons/hi2';
import { useQuery } from '@tanstack/react-query';
import { fetchRichList, fetchDistribution, fetchStats } from '../services/api';
import { formatNumber, truncateHash, formatAge, formatDate } from '../utils/formatters';
import { usePageVisibility } from '../hooks/usePageVisibility';
import './PageStyles.css';
import { addressPath } from '../utils/routes';

export default function RichListPage() {
  const [page, setPage] = useState(1);
  const isPageVisible = usePageVisibility();

  const richListQuery = useQuery({
    queryKey: ['richlist', page, 100],
    queryFn: () => fetchRichList(page, 100),
    staleTime: 45_000,
    refetchInterval: isPageVisible ? 90_000 : false,
  });
  const { data: dist } = useQuery({
    queryKey: ['richlist-distribution'],
    queryFn: fetchDistribution,
    staleTime: 45_000,
    refetchInterval: isPageVisible ? 90_000 : false,
  });
  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
    staleTime: 45_000,
    refetchInterval: isPageVisible ? 90_000 : false,
  });
  const richData = richListQuery.data;
  const loading = richListQuery.isLoading;

  const addresses = richData?.data || [];
  const pagination = richData?.pagination || { page: 1, pages: 1, total: 0 };
  const supply = stats?.supply?.circulating || dist?.moneySupply || 1;

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title"><HiOutlineListBullet /> Rich List</h1>
        <p className="page-subtitle">Top DEFCON addresses ranked by balance</p>
      </div>

      <div className="grid-stats" style={{ marginBottom: '1.5rem' }}>
        <div className="stat-card">
          <div className="stat-label"><HiOutlineTrophy /> Total Addresses</div>
          <div className="stat-value">{formatNumber(dist?.totalAddresses || stats?.totalAddresses || 0)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Circulating Supply</div>
          <div className="stat-value">{formatNumber(supply)}</div>
          <div className="stat-change">DFCN</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top 10 Hold</div>
          <div className="stat-value">{(dist?.top10?.percentage || 0).toFixed(1)}%</div>
          <div className="stat-change">of total supply</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top 100 Hold</div>
          <div className="stat-value">{(dist?.top100?.percentage || 0).toFixed(1)}%</div>
          <div className="stat-change">of total supply</div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading rich list...</div>
        ) : addresses.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>No addresses with balance found yet</div>
        ) : (
          <>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Address</th>
                    <th>Balance (DFCN)</th>
                    <th>% of Supply</th>
                    <th>TX Count</th>
                    <th>Last Active</th>
                  </tr>
                </thead>
                <tbody>
                  {addresses.map((entry) => {
                    const pct = supply > 0 ? (entry.balance / supply) * 100 : 0;
                    return (
                      <tr key={entry.rank}>
                        <td>
                          <span className={`badge ${entry.rank <= 3 ? 'warning' : ''}`}>
                            #{entry.rank}
                          </span>
                        </td>
                        <td>
                          <Link to={addressPath(entry.address)} className="hash mono">
                            {truncateHash(entry.address, 12)}
                          </Link>
                        </td>
                        <td className="mono" style={{ fontWeight: 600 }}>
                          {formatNumber(entry.balance, 2)}
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div className="supply-bar" style={{ width: '60px' }}>
                              <div className="supply-bar-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
                            </div>
                            <span className="text-secondary">{pct.toFixed(2)}%</span>
                          </div>
                        </td>
                        <td>{formatNumber(entry.txCount)}</td>
                        <td className="text-muted" title={entry.lastSeen ? formatDate(entry.lastSeen) : undefined}>
                          {entry.lastSeen ? formatAge(entry.lastSeen) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {pagination.pages > 1 && (
              <div className="pagination">
                <button onClick={() => setPage(1)} disabled={page <= 1}>&laquo;</button>
                <button onClick={() => setPage(page - 1)} disabled={page <= 1}>&lsaquo;</button>
                <span style={{ padding: '0.5rem 1rem', color: 'var(--text-secondary)' }}>
                  Page {page} of {pagination.pages}
                </span>
                <button onClick={() => setPage(page + 1)} disabled={page >= pagination.pages}>&rsaquo;</button>
                <button onClick={() => setPage(pagination.pages)} disabled={page >= pagination.pages}>&raquo;</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
