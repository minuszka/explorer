import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  HiOutlineArrowPath,
  HiOutlineBolt,
  HiOutlineExclamationTriangle,
  HiOutlineServerStack,
  HiOutlineSignal,
} from 'react-icons/hi2';
import { fetchNetworkNoiseSummary } from '../services/api';
import { usePageVisibility } from '../hooks/usePageVisibility';
import { formatNumber, truncateHash } from '../utils/formatters';
import type { NetworkNoiseLevel } from '../types/api';
import './PageStyles.css';
import './NetworkNoisePage.css';

const WINDOW_OPTIONS = [
  { hours: 1, label: '1h' },
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
  { hours: 168, label: '7d' },
];

const CHAIN_SIGNALS = new Set(['chainlock_conflict', 'chain_tip_divergence', 'reorg_attempt']);

function signalLabel(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function timeAgo(value: string | null): string {
  if (!value) return '-';
  const age = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(age) || age < 0) return '-';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function levelLabel(level: NetworkNoiseLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export default function NetworkNoisePage() {
  const isPageVisible = usePageVisibility();
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [hours, setHours] = useState(24);
  const [nodeFilter, setNodeFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const { data: response, dataUpdatedAt, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['devtools', 'network-noise', hours],
    queryFn: () => fetchNetworkNoiseSummary(hours),
    staleTime: 30_000,
    refetchInterval: isPageVisible ? 60_000 : false,
  });
  const data = error ? undefined : response;
  const now = Math.max(clock, Date.now());
  const maxAge = data ? data.staleAfterSeconds * 1000 : 0;
  const reportIsFresh = (reportedAt: string) => {
    const age = now - Date.parse(reportedAt);
    return Number.isFinite(age) && age >= 0 && age <= maxAge;
  };
  const generatedAge = data ? now - Date.parse(data.generatedAt) : NaN;
  const receivedAge = now - dataUpdatedAt;
  const serverFreshNodes = data?.nodes.filter((node) => !node.isStale) ?? [];
  const snapshotCurrent = Boolean(data && maxAge > 0 && Number.isFinite(generatedAge)
    && generatedAge >= -5000 && generatedAge <= maxAge && receivedAge >= 0 && receivedAge <= maxAge
    && serverFreshNodes.length === data.summary.reportingNodes
    && serverFreshNodes.every((node) => reportIsFresh(node.lastReportedAt)));
  const hasFreshReports = Boolean(snapshotCurrent && data && data.summary.reportingNodes > 0);

  const nodes = useMemo(
    () =>
      (data?.nodes ?? []).filter((node) => {
        if (roleFilter !== 'all' && node.nodeRole !== roleFilter) return false;
        if (nodeFilter !== 'all' && node.nodeId !== nodeFilter) return false;
        return true;
      }),
    [data?.nodes, nodeFilter, roleFilter]
  );

  const roles = useMemo(
    () => Array.from(new Set((data?.nodes ?? []).map((node) => node.nodeRole))).sort(),
    [data?.nodes]
  );

  const timeline = useMemo(() => {
    const grouped = new Map<
      string,
      { bucket: string; total: number; chain: number; nodes: Set<string> }
    >();
    for (const row of data?.timeline ?? []) {
      const entry = grouped.get(row.bucket) ?? {
        bucket: row.bucket,
        total: 0,
        chain: 0,
        nodes: new Set<string>(),
      };
      entry.total += row.count;
      if (CHAIN_SIGNALS.has(row.signalType)) entry.chain += row.count;
      row.nodes.forEach((node) => entry.nodes.add(node));
      grouped.set(row.bucket, entry);
    }
    return [...grouped.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  }, [data?.timeline]);

  const maxTimelineValue = Math.max(1, ...timeline.map((entry) => entry.total));
  const recentSignals = useMemo(
    () =>
      (data?.recentSignals ?? []).filter((signal) =>
        nodeFilter === 'all' ? true : signal.nodeId === nodeFilter
      ),
    [data?.recentSignals, nodeFilter]
  );

  return (
    <div className="fade-in nn-shell">
      <section className="nn-hero">
        <div>
          <span className="nn-kicker"><HiOutlineSignal /> Dev Tools</span>
          <h1 className="page-title"><HiOutlineBolt /> Network Noise Monitor</h1>
          <p className="page-subtitle">
            Correlated ChainLock, fork, quorum, sync, and peer signals reported by monitored DeFCoN nodes.
          </p>
        </div>
        <button className="button" type="button" onClick={() => refetch()} disabled={isFetching}>
          <HiOutlineArrowPath className={isFetching ? 'spin' : undefined} />
          {isFetching ? 'Refreshing...' : 'Refresh'}
        </button>
      </section>

      <div className="nn-evidence-note">
        <HiOutlineExclamationTriangle />
        Correlation is evidence, not proof of causation. IP, provider, and wallet-version matches are shown as context.
      </div>
      {data && !snapshotCurrent && <p role="status">Current report data expired or has an invalid timestamp. Refresh to verify.</p>}

      <section className="nn-stats">
        <Stat
          label="Current noise"
          value={hasFreshReports && data ? levelLabel(data.summary.currentLevel) : isLoading ? '...' : 'Unknown'}
          detail={hasFreshReports && data ? `score ${data.summary.currentScore}/100` : error ? 'Telemetry unavailable' : isLoading ? undefined : snapshotCurrent ? 'No fresh reports' : 'Freshness unknown'}
          tone={hasFreshReports ? data?.summary.currentLevel : undefined}
        />
        <Stat label="Reporting nodes" value={snapshotCurrent && data ? `${data.summary.reportingNodes}/${data.summary.knownNodes}` : isLoading ? '...' : 'Unknown'} detail="fresh agent heartbeat" />
        <Stat label="Active signals" value={hasFreshReports && data ? formatNumber(data.summary.activeSignals) : isLoading ? '...' : 'Unknown'} detail="latest reporting cycle" />
        <Stat label="Chain alerts" value={hasFreshReports && data ? formatNumber(data.summary.chainAlerts) : isLoading ? '...' : 'Unknown'} detail="nodes with chain-related signals" tone={hasFreshReports ? data?.summary.chainAlerts ? 'severe' : 'quiet' : undefined} />
        <Stat label="Stale agents" value={snapshotCurrent && data ? formatNumber(data.summary.staleNodes) : isLoading ? '...' : 'Unknown'} detail="Missing, old, or unverified report data" tone={snapshotCurrent && data ? data.summary.staleNodes ? 'elevated' : 'quiet' : undefined} />
      </section>

      <section className="card nn-card">
        <div className="card-header nn-card-header">
          <div>
            <h2 className="card-title">Noise activity</h2>
            <p className="nn-description">Stored historical signals; amber/red segments are chain-related.</p>
          </div>
          <div className="nn-window-tabs" aria-label="Timeline window">
            {WINDOW_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.hours}
                className={hours === option.hours ? 'active' : ''}
                onClick={() => setHours(option.hours)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <Empty>Failed to load network noise data: {(error as Error).message}</Empty>
        ) : isLoading ? (
          <Empty>Loading telemetry...</Empty>
        ) : timeline.length === 0 ? (
          <Empty>No stored noise signals in this window.</Empty>
        ) : (
          <div className="nn-timeline-wrap">
            <div className="nn-timeline" style={{ minWidth: Math.max(680, timeline.length * 13) }}>
              {timeline.map((entry) => {
                const height = Math.max(4, (entry.total / maxTimelineValue) * 100);
                const chainShare = entry.total > 0 ? (entry.chain / entry.total) * 100 : 0;
                return (
                  <div
                    className="nn-timeline-column"
                    key={entry.bucket}
                    title={`${new Date(entry.bucket).toLocaleString()} · ${entry.total} signals · ${entry.nodes.size} nodes`}
                  >
                    <div className="nn-timeline-bar" style={{ height: `${height}%` }}>
                      <span className="nn-timeline-chain" style={{ height: `${chainShare}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="nn-timeline-legend">
              <span><i className="nn-dot nn-dot-other" /> Other signals</span>
              <span><i className="nn-dot nn-dot-chain" /> Chain-related</span>
            </div>
          </div>
        )}
      </section>

      <section className="card nn-card">
        <div className="card-header nn-card-header">
          <div>
            <h2 className="card-title">Reporting nodes</h2>
            <p className="nn-description">Select a node to focus the signal history below.</p>
          </div>
          <div className="nn-filters">
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} aria-label="Node role">
              <option value="all">All roles</option>
              {roles.map((role) => <option value={role} key={role}>{signalLabel(role)}</option>)}
            </select>
            <select value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value)} aria-label="Node">
              <option value="all">All nodes</option>
              {(data?.nodes ?? []).map((node) => <option value={node.nodeId} key={node.nodeId}>{node.nodeId}</option>)}
            </select>
          </div>
        </div>

        {nodes.length === 0 ? (
          <Empty>No reporting nodes match the selected filters.</Empty>
        ) : (
          <div className="nn-table-wrap">
            <table className="nn-table">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Role / version</th>
                  <th>Height / hash</th>
                  <th>ChainLock</th>
                  <th>Peers</th>
                  <th>Noise</th>
                  <th>Reported</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.nodeId} onClick={() => setNodeFilter(node.nodeId)}>
                    <td><strong>{node.nodeId}</strong></td>
                    <td><span className="badge">{signalLabel(node.nodeRole)}</span><span>{node.walletVersion || 'Unknown version'}</span></td>
                    <td><strong className="mono">{node.blockHeight != null ? formatNumber(node.blockHeight) : '-'}</strong><span className="mono">{node.bestBlockHash ? truncateHash(node.bestBlockHash, 5) : '-'}</span></td>
                    <td><strong className="mono">{node.chainLockHeight != null ? formatNumber(node.chainLockHeight) : '-'}</strong><span className="mono">{node.chainLockHash ? truncateHash(node.chainLockHash, 5) : '-'}</span></td>
                    <td><strong>{node.connections ?? '-'}</strong><span>{node.inbound ?? '-'} in / {node.outbound ?? '-'} out</span></td>
                    <td><span className={`nn-level nn-level-${node.isStale || !reportIsFresh(node.lastReportedAt) || !snapshotCurrent ? 'stale' : levelForScore(node.noiseScore)}`}>{node.isStale || !reportIsFresh(node.lastReportedAt) ? 'STALE' : !snapshotCurrent ? 'UNKNOWN' : `${node.noiseScore}/100`}</span><span>{node.signalCount} signals</span></td>
                    <td><strong>{timeAgo(node.lastReportedAt)}</strong><span>{node.activeSignalTypes.map(signalLabel).join(', ') || 'Clean'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card nn-card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Recent signal evidence</h2>
            <p className="nn-description">Redacted observations, newest first. Repeated polls are deduplicated by node, sequence, type, and fingerprint.</p>
          </div>
          <span className="badge badge-accent">{recentSignals.length} records</span>
        </div>

        {recentSignals.length === 0 ? (
          <Empty>No signal evidence for the selected node and time window.</Empty>
        ) : (
          <div className="nn-signal-list">
            {recentSignals.map((signal) => (
              <article className="nn-signal" key={`${signal.nodeId}:${signal.fingerprint}:${signal.lastSeenAt}`}>
                <div className="nn-signal-head">
                  <span className={`nn-signal-type ${CHAIN_SIGNALS.has(signal.signalType) ? 'chain' : ''}`}>{signalLabel(signal.signalType)}</span>
                  <strong>{signal.count}x</strong>
                  <span>{timeAgo(signal.lastSeenAt)}</span>
                </div>
                <div className="nn-signal-context">
                  <span><HiOutlineServerStack /> {signal.nodeId}</span>
                  <span>{signal.walletVersion || 'Unknown version'}</span>
                </div>
                {signal.sample && <code>{signal.sample}</code>}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function levelForScore(score: number): NetworkNoiseLevel {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'severe';
  if (score >= 35) return 'noisy';
  if (score >= 15) return 'elevated';
  return 'quiet';
}

function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: NetworkNoiseLevel;
}) {
  return (
    <div className={`nn-stat${tone ? ` nn-stat-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="nn-empty">{children}</div>;
}
