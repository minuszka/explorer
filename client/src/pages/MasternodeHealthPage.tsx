import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  HiOutlineHeart,
  HiOutlineExclamationTriangle,
  HiOutlineShieldExclamation,
  HiOutlineServerStack,
  HiOutlineClock,
  HiOutlineFire,
  HiOutlineArrowPath,
} from 'react-icons/hi2';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { fetchMasternodeHealth } from '../services/api';
import { useChartAnimation } from '../utils/chartAnimation';
import { formatNumber, truncateHash } from '../utils/formatters';
import TimeText from '../components/ui/TimeText';
import type { MasternodeHealthView } from '../types/api';
import { usePageVisibility } from '../hooks/usePageVisibility';
import './PageStyles.css';
import './MasternodeHealthPage.css';

type WindowKey = '24h' | '7d' | '30d';

const WINDOW_OPTIONS: { key: WindowKey; label: string; hours: number; bucket: 'hour' | 'day' }[] = [
  { key: '24h', label: '24h', hours: 24, bucket: 'hour' },
  { key: '7d', label: '7 days', hours: 168, bucket: 'day' },
  { key: '30d', label: '30 days', hours: 720, bucket: 'day' },
];

const STATUS_COLORS: Record<string, string> = {
  ENABLED: '#25c281',
  POSE_BANNED: '#ef4d56',
  POSE_PENALTY: '#f5a623',
  NEW: '#2f8fff',
  REMOVED: '#888',
};

function statusChipClass(status: string): string {
  return `mnh-chip ${status.toLowerCase()}`;
}

function timeAgo(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '—';
  const diffSec = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 48) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  return `${diffD}d ago`;
}

// Chart buckets are UTC hours and days; label them in UTC whatever the browser's language.
const HOUR_BUCKET_LABEL = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY_BUCKET_LABEL = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

function formatBucket(bucket: string, kind: 'hour' | 'day'): string {
  // bucket strings: hourly = 'YYYY-MM-DDTHH:00:00Z'; daily = 'YYYY-MM-DD'
  const d = new Date(kind === 'hour' ? bucket : `${bucket}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return bucket;
  return kind === 'hour' ? HOUR_BUCKET_LABEL.format(d) : DAY_BUCKET_LABEL.format(d);
}

export default function MasternodeHealthPage() {
  const [windowKey, setWindowKey] = useState<WindowKey>('7d');
  const windowOpt = WINDOW_OPTIONS.find((w) => w.key === windowKey) ?? WINDOW_OPTIONS[1];
  const isPageVisible = usePageVisibility();
  const chartAnimation = useChartAnimation();

  const healthQuery = useQuery<MasternodeHealthView>({
    queryKey: ['mn-health', windowOpt.hours, windowOpt.bucket],
    queryFn: () => fetchMasternodeHealth(windowOpt.hours, windowOpt.bucket, 15),
    refetchInterval: isPageVisible ? 90_000 : false,
    staleTime: 45_000,
  });

  const data = healthQuery.data;
  const isLoading = healthQuery.isLoading;
  const error = healthQuery.error as Error | null;

  const totalDrops = useMemo(
    () => (data ? data.timeline.reduce((sum, p) => sum + p.total, 0) : 0),
    [data],
  );
  const totalPoseBanned = useMemo(
    () => (data ? data.timeline.reduce((sum, p) => sum + p.poseBanned, 0) : 0),
    [data],
  );
  const totalRemoved = useMemo(
    () => (data ? data.timeline.reduce((sum, p) => sum + p.removed, 0) : 0),
    [data],
  );

  const statusPieData = useMemo(() => {
    if (!data) return [];
    const s = data.snapshot.statusCounts;
    return Object.entries(s)
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({
        name,
        value,
        color: STATUS_COLORS[name] ?? '#888',
      }));
  }, [data]);

  const timelineData = useMemo(() => {
    if (!data) return [];
    return data.timeline.map((p) => ({
      ...p,
      label: formatBucket(p.bucket, data.bucket),
    }));
  }, [data]);

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">
          <HiOutlineHeart /> MN Health
        </h1>
        <p className="page-subtitle">
          Real-time masternode health: status snapshot, drop timeline, top offenders, and event history.
        </p>
      </div>

      {/* Window selector */}
      <div className="mnh-controls">
        <span className="mnh-control-label">Window:</span>
        <div className="mnh-segmented">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={opt.key === windowKey ? 'active' : ''}
              onClick={() => setWindowKey(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="mnh-segmented mnh-refresh-btn"
          style={{ padding: 0 }}
          onClick={() => healthQuery.refetch()}
          title="Refresh"
        >
          <span className="mnh-refresh-label">
            <HiOutlineArrowPath /> Refresh
          </span>
        </button>
        {data && (
          <span className="mnh-meta-line" style={{ marginLeft: 'auto' }}>
            Updated {timeAgo(data.generatedAt)} · bucket: {data.bucket}
            {!data.rpcAvailable && (
              <span className="mnh-down-flag"> (RPC unavailable — snapshot stale)</span>
            )}
          </span>
        )}
      </div>

      {error && (
        <div className="mnh-error">
          Failed to load MN health data: {error.message}
        </div>
      )}

      {/* Snapshot cards */}
      <div className="mnh-health-grid">
        <div className="mnh-card success">
          <div className="mnh-card-label">
            <HiOutlineShieldExclamation /> Health Score
          </div>
          <div className="mnh-card-value">
            {isLoading || !data ? '…' : `${data.snapshot.healthScore.toFixed(1)}%`}
          </div>
          <div className="mnh-card-sub">Active / Total</div>
          <div className="mnh-health-score-bar">
            <div
              className="mnh-health-score-fill"
              style={{ width: `${Math.min(100, Math.max(0, data?.snapshot.healthScore ?? 0))}%` }}
            />
          </div>
        </div>

        <div className="mnh-card">
          <div className="mnh-card-label">
            <HiOutlineServerStack /> Total Nodes
          </div>
          <div className="mnh-card-value">
            {isLoading || !data ? '…' : formatNumber(data.snapshot.total)}
          </div>
          <div className="mnh-card-sub">
            Active: {data?.snapshot.enabled ?? 0}
          </div>
        </div>

        <div className="mnh-card danger">
          <div className="mnh-card-label">
            <HiOutlineExclamationTriangle /> POSE Banned (now)
          </div>
          <div className="mnh-card-value">
            {isLoading || !data ? '…' : formatNumber(data.snapshot.poseBanned)}
          </div>
          <div className="mnh-card-sub">
            +{data?.snapshot.posePenalty ?? 0} with PoSe penalty
          </div>
        </div>

        <div className="mnh-card warning">
          <div className="mnh-card-label">
            <HiOutlineFire /> Drops in window
          </div>
          <div className="mnh-card-value">
            {isLoading || !data ? '…' : formatNumber(totalDrops)}
          </div>
          <div className="mnh-card-sub">
            {totalPoseBanned} banned · {totalRemoved} removed
          </div>
        </div>

        <div className="mnh-card">
          <div className="mnh-card-label">
            <HiOutlineClock /> Window
          </div>
          <div className="mnh-card-value">
            {data ? `${data.windowHours}h` : '…'}
          </div>
          <div className="mnh-card-sub">
            {WINDOW_OPTIONS.find((o) => o.key === windowKey)?.label}
          </div>
        </div>
      </div>

      {/* Timeline + Status pie */}
      <div className="mnh-grid-2">
        <section className="mnh-panel">
          <div className="mnh-panel-header">
            <h2 className="mnh-panel-title">
              <HiOutlineFire /> Drop Timeline
            </h2>
            <span className="mnh-panel-sub">POSE_BANNED + REMOVED, per {data?.bucket ?? 'bucket'}</span>
          </div>
          {timelineData.length === 0 && !isLoading ? (
            <div className="mnh-empty">No drop events in this window. 🎉</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={timelineData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" opacity={0.4} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-color-muted)' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-color-muted)' }} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 10,
                    fontSize: 12,
                    color: 'var(--text-color)',
                  }}
                  labelStyle={{ color: 'var(--text-color)' }}
                  itemStyle={{ color: 'var(--text-color)' }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="poseBanned" stackId="d" name="POSE Banned" fill="#ef4d56" {...chartAnimation} />
                <Bar dataKey="removed" stackId="d" name="Removed" fill="#888" {...chartAnimation} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </section>

        <section className="mnh-panel">
          <div className="mnh-panel-header">
            <h2 className="mnh-panel-title">
              <HiOutlineShieldExclamation /> Status Distribution (live)
            </h2>
            <span className="mnh-panel-sub">From RPC snapshot</span>
          </div>
          {statusPieData.length === 0 ? (
            <div className="mnh-empty">{isLoading ? 'Loading…' : 'No data.'}</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={statusPieData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={60}
                  outerRadius={105}
                  paddingAngle={2}
                  {...chartAnimation}
                >
                  {statusPieData.map((s) => (
                    <Cell key={s.name} fill={s.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 10,
                    fontSize: 12,
                    color: 'var(--text-color)',
                  }}
                  labelStyle={{ color: 'var(--text-color)' }}
                  itemStyle={{ color: 'var(--text-color)' }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </section>
      </div>

      {/* Top offenders */}
      <section className="mnh-panel">
        <div className="mnh-panel-header">
          <h2 className="mnh-panel-title">
            <HiOutlineExclamationTriangle /> Top Drop Offenders
          </h2>
          <span className="mnh-panel-sub">
            Nodes with most POSE_BANNED + REMOVED events in window
          </span>
        </div>
        <div className="mnh-table-wrap">
          <table className="mnh-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Node ID / Service</th>
                <th>Country</th>
                <th>Provider</th>
                <th>Current</th>
                <th style={{ textAlign: 'right' }}>Drops</th>
                <th style={{ textAlign: 'right' }}>POSE</th>
                <th style={{ textAlign: 'right' }}>Removed</th>
                <th>Last Drop</th>
              </tr>
            </thead>
            <tbody>
              {(!data || data.offenders.length === 0) && (
                <tr>
                  <td colSpan={9} className="mnh-empty">
                    {isLoading ? 'Loading…' : 'No drop events recorded in this window.'}
                  </td>
                </tr>
              )}
              {data?.offenders.map((o, i) => (
                <tr key={o.nodeId}>
                  <td>{i + 1}</td>
                  <td>
                    <Link
                      className="mnh-link mnh-mono"
                      to={`/masternodes`}
                      title={o.nodeId}
                    >
                      {truncateHash(o.proTxHash || o.nodeId, 6)}
                    </Link>
                    <div className="mnh-meta-line mnh-mono">{o.lastService || '—'}</div>
                  </td>
                  <td>
                    {o.countryCode !== 'UNK' ? `${o.countryCode}` : '—'}
                    <div className="mnh-meta-line">{o.countryName}</div>
                  </td>
                  <td>
                    <span
                      className="badge"
                      title={
                        o.asnOrg
                          ? `${o.asnOrg}${o.asn ? ` (AS${o.asn})` : ''}`
                          : (o.provider ?? 'Unknown provider')
                      }
                    >
                      {o.provider || 'Unknown'}
                    </span>
                    {o.asn && (!o.provider || o.provider === 'Unknown') && (
                      <div className="mnh-meta-line mnh-mono">AS{o.asn}</div>
                    )}
                  </td>
                  <td>
                    <span className={statusChipClass(o.currentStatus)}>{o.currentStatus}</span>
                    {o.isCurrentlyDown && <span className="mnh-down-flag">DOWN</span>}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{o.dropCount}</td>
                  <td style={{ textAlign: 'right', color: '#ef4d56' }}>{o.poseBannedCount}</td>
                  <td style={{ textAlign: 'right', color: '#888' }}>{o.removedCount}</td>
                  <td>{timeAgo(o.lastDropAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent critical events */}
      <section className="mnh-panel">
        <div className="mnh-panel-header">
          <h2 className="mnh-panel-title">
            <HiOutlineClock /> Recent Critical Events
          </h2>
          <span className="mnh-panel-sub">Latest POSE_BANNED + REMOVED transitions</span>
        </div>
        <div className="mnh-table-wrap">
          <table className="mnh-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Node ID</th>
                <th>Service</th>
                <th>Provider</th>
                <th>Transition</th>
              </tr>
            </thead>
            <tbody>
              {(!data || data.recentEvents.length === 0) && (
                <tr>
                  <td colSpan={5} className="mnh-empty">
                    {isLoading ? 'Loading…' : 'No critical events in this window.'}
                  </td>
                </tr>
              )}
              {data?.recentEvents.map((e) => (
                <tr key={`${e.nodeId}-${e.detectedAt}`}>
                  <td>
                    {timeAgo(e.detectedAt)}
                    <div className="mnh-meta-line">
                      <TimeText value={e.detectedAt} />
                    </div>
                  </td>
                  <td className="mnh-mono">{truncateHash(e.nodeId, 6)}</td>
                  <td className="mnh-mono">{e.service || '—'}</td>
                  <td>
                    <span
                      className="badge"
                      title={
                        e.asnOrg
                          ? `${e.asnOrg}${e.asn ? ` (AS${e.asn})` : ''}`
                          : (e.provider ?? 'Unknown provider')
                      }
                    >
                      {e.provider || 'Unknown'}
                    </span>
                    {e.asn && (!e.provider || e.provider === 'Unknown') && (
                      <div className="mnh-meta-line mnh-mono">AS{e.asn}</div>
                    )}
                  </td>
                  <td>
                    <span className={statusChipClass(e.previousStatus)}>{e.previousStatus}</span>
                    <span style={{ margin: '0 0.4rem', color: 'var(--text-color-muted)' }}>→</span>
                    <span className={statusChipClass(e.currentStatus)}>{e.currentStatus}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Status transition breakdown */}
      {data && data.statusBreakdown.length > 0 && (
        <section className="mnh-panel">
          <div className="mnh-panel-header">
            <h2 className="mnh-panel-title">
              <HiOutlineHeart /> All Transitions in Window
            </h2>
            <span className="mnh-panel-sub">Counts of every status change recorded</span>
          </div>
          <div className="mnh-table-wrap">
            <table className="mnh-table">
              <thead>
                <tr>
                  <th>Target Status</th>
                  <th style={{ textAlign: 'right' }}>Events</th>
                </tr>
              </thead>
              <tbody>
                {data.statusBreakdown.map((s) => (
                  <tr key={s.status}>
                    <td>
                      <span className={statusChipClass(s.status)}>{s.status}</span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatNumber(s.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* PoSe Penalty Watchlist */}
      {data && data.poseWatchlist.length > 0 && (
        <section className="mnh-panel">
          <div className="mnh-panel-header">
            <h2 className="mnh-panel-title">
              <HiOutlineExclamationTriangle /> PoSe Penalty Watchlist
            </h2>
            <span className="mnh-panel-sub">
              ENABLED nodes accumulating PoSe score — closer to threshold = closer to ban
            </span>
          </div>
          <div className="mnh-table-wrap">
            <table className="mnh-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Node</th>
                  <th>Country</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>PoSe Score</th>
                  <th>Risk</th>
                  <th>Payout</th>
                </tr>
              </thead>
              <tbody>
                {data.poseWatchlist.slice(0, 25).map((p, i) => {
                  const max = data.poseWatchlist[0]?.posePenalty || 1;
                  const pct = Math.max(8, Math.round((p.posePenalty / max) * 100));
                  return (
                    <tr key={p.nodeId}>
                      <td>{i + 1}</td>
                      <td>
                        <span className="mnh-mono" title={p.nodeId}>
                          {truncateHash(p.proTxHash || p.nodeId, 6)}
                        </span>
                        <div className="mnh-meta-line mnh-mono">{p.service || '—'}</div>
                      </td>
                      <td>
                        {p.countryCode !== 'UNK' ? p.countryCode : '—'}
                        <div className="mnh-meta-line">{p.countryName}</div>
                      </td>
                      <td>
                        <span className={statusChipClass(p.status)}>{p.status}</span>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#f5a623' }}>
                        {formatNumber(p.posePenalty)}
                      </td>
                      <td>
                        <div className="mnh-penalty-bar-wrap">
                          <div className="mnh-penalty-bar-fill" style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                      <td>
                        {p.payoutAddress ? (
                          <Link className="mnh-link mnh-mono" to={`/address/${p.payoutAddress}`}>
                            {truncateHash(p.payoutAddress, 6)}
                          </Link>
                        ) : (
                          <span className="mnh-meta-line">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Cluster analysis */}
      {data &&
        (data.clusters.operator.length > 0 ||
          data.clusters.ip.length > 0 ||
          data.clusters.subnet.length > 0) && (
          <section className="mnh-panel">
            <div className="mnh-panel-header">
              <h2 className="mnh-panel-title">
                <HiOutlineShieldExclamation /> Cluster Analysis
              </h2>
              <span className="mnh-panel-sub">
                Multiple masternodes sharing operator key, IP or /24 subnet — Sybil / collusion risk
              </span>
            </div>
            {data.clusters.operator.length > 0 && (
              <>
                <h3 style={{ margin: '0.6rem 0 0.4rem', fontSize: '0.95rem' }}>
                  Operator Key Clusters ({data.clusters.operator.length})
                </h3>
                <ClusterList items={data.clusters.operator} keyLabel="operator" />
              </>
            )}
            {data.clusters.ip.length > 0 && (
              <>
                <h3 style={{ margin: '1rem 0 0.4rem', fontSize: '0.95rem' }}>
                  IP Address Clusters ({data.clusters.ip.length})
                </h3>
                <ClusterList items={data.clusters.ip} keyLabel="ip" />
              </>
            )}
            {data.clusters.subnet.length > 0 && (
              <>
                <h3 style={{ margin: '1rem 0 0.4rem', fontSize: '0.95rem' }}>
                  /24 Subnet Clusters ({data.clusters.subnet.length})
                </h3>
                <ClusterList items={data.clusters.subnet} keyLabel="subnet" />
              </>
            )}
          </section>
        )}
    </div>
  );
}

function ClusterList({
  items,
  keyLabel,
}: {
  items: MasternodeHealthView['clusters']['operator'];
  keyLabel: string;
}) {
  return (
    <div className="mnh-cluster-list">
      {items.map((c) => (
        <div className="mnh-cluster-item" key={`${keyLabel}-${c.key}`}>
          <div className="mnh-cluster-head">
            <span className={`mnh-evidence ${c.evidence}`}>{c.evidence}</span>
            <span className="mnh-cluster-key" title={c.key}>
              {keyLabel === 'operator' ? truncateHash(c.key, 10) : c.key}
            </span>
            <span className="mnh-cluster-stat">
              {c.totalNodes} node{c.totalNodes === 1 ? '' : 's'} ·{' '}
              <span style={{ color: c.bannedNodes > 0 ? '#ef4d56' : 'inherit' }}>
                {c.bannedNodes} down
              </span>
            </span>
            {c.dominantProvider && (
              <span
                className="badge"
                style={{ marginLeft: '0.4rem' }}
                title={`Dominant hosting provider: ${c.dominantProvider.count}/${c.totalNodes} nodes`}
              >
                {c.dominantProvider.name} {c.dominantProvider.share}%
              </span>
            )}
          </div>
          <div className="mnh-cluster-nodes">
            {c.nodes.map((n) => (
              <span
                key={n.nodeId}
                className={`mnh-cluster-node-pill ${
                  n.status !== 'ENABLED' && n.status !== 'POSE_PENALTY' ? 'down' : ''
                }`}
                title={`${n.service} · ${n.status}${n.provider ? ` · ${n.provider}` : ''}${n.asn ? ` (AS${n.asn})` : ''}`}
              >
                {truncateHash(n.proTxHash || n.nodeId, 5)}
                {n.countryCode !== 'UNK' && ` · ${n.countryCode}`}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
