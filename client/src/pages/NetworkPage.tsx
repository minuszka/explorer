import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  HiOutlineGlobeAlt,
  HiOutlineSignal,
  HiOutlineServerStack,
} from 'react-icons/hi2';
import { useQuery } from '@tanstack/react-query';
import { fetchNetworkInfo, fetchActiveMasternodeVersions } from '../services/api';
import type { ActiveMasternodeVersionsView, NetworkView } from '../types/api';
import { formatNumber, formatAge } from '../utils/formatters';
import { usePageVisibility } from '../hooks/usePageVisibility';
import './PageStyles.css';
import './NetworkPage.css';

interface VersionDatum {
  name: string;
  value: number;
  color: string;
  sharePct: number;
  isDeprecated: boolean;
  isUnknown?: boolean;
}

const versionColors = ['#1f64d8', '#2f8fff', '#58a8ff', '#4f7fd8', '#5cbfff', '#3f6fc6'];

type VersionScope = 'inventory' | 'direct';
type PeerSyncState = 'in-sync' | 'minor-lag' | 'behind' | 'ahead' | 'unavailable';

interface PeerSyncAssessment {
  state: PeerSyncState;
  label: string;
  delta: number | null;
}

function countryCodeToFlag(code: string): string {
  if (!code || code.length !== 2) return '??';
  const upper = code.toUpperCase();
  const first = upper.codePointAt(0);
  const second = upper.codePointAt(1);
  if (!first || !second) return '??';
  return String.fromCodePoint(first + 127397, second + 127397);
}

function formatObservedAge(value: string | null | undefined, nowMs = Date.now()): string {
  if (!value) return 'N/A';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'N/A';
  const seconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** The Masternodes table filtered to one version; the unknown row shows nodes without a reported version. */
function masternodesWithVersion(entry: VersionDatum): string {
  return `/masternodes?version=${encodeURIComponent(entry.isUnknown ? 'unknown' : entry.name)}`;
}

function getPeerReportedHeight(peer: NetworkView['peers'][number]): number | null {
  const values = [peer.synced_blocks, peer.synced_headers]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function assessPeerSync(peer: NetworkView['peers'][number], explorerHeight: number | null): PeerSyncAssessment {
  const reportedHeight = getPeerReportedHeight(peer);
  if (explorerHeight == null || reportedHeight == null) {
    return { state: 'unavailable', label: 'No sync data', delta: null };
  }

  const delta = reportedHeight - explorerHeight;
  if (delta === 0) return { state: 'in-sync', label: 'In sync', delta };
  if (delta < 0 && delta >= -2) return { state: 'minor-lag', label: `Behind ${Math.abs(delta)}`, delta };
  if (delta < 0) return { state: 'behind', label: `Behind ${Math.abs(delta)}`, delta };
  return { state: 'ahead', label: `Reports +${delta}`, delta };
}

function parseVersionParts(value: string | undefined): number[] | null {
  const match = value?.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isOlderPeerVersion(value: string | undefined, requiredVersion: string | undefined): boolean {
  const candidate = parseVersionParts(value);
  const required = parseVersionParts(requiredVersion);
  if (!candidate || !required) return false;
  for (let index = 0; index < required.length; index += 1) {
    if (candidate[index] !== required[index]) return candidate[index] < required[index];
  }
  return false;
}

export default function NetworkPage() {
  const isPageVisible = usePageVisibility();
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [versionScope, setVersionScope] = useState<VersionScope>('inventory');
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!isPageVisible) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [isPageVisible]);
  const networkQuery = useQuery<NetworkView>({
    queryKey: ['network'],
    queryFn: fetchNetworkInfo,
    staleTime: 15_000,
    refetchInterval: isPageVisible ? 30_000 : false,
    refetchOnMount: 'always',
  });
  const network = networkQuery.data;
  const versionSampleQuery = useQuery<ActiveMasternodeVersionsView>({
    queryKey: ['network', 'active-masternode-versions'],
    queryFn: fetchActiveMasternodeVersions,
    staleTime: 15_000,
    refetchInterval: isPageVisible ? 30_000 : false,
    refetchOnMount: 'always',
    retry: 1,
  });
  const versionSample = versionSampleQuery.isError ? undefined : versionSampleQuery.data;
  const loading = networkQuery.isLoading;
  const error =
    networkQuery.error != null
      ? ((networkQuery.error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ||
          (networkQuery.error as Error)?.message ||
          'Failed to load network info')
      : null;

  const peers = useMemo(() => network?.peers || [], [network?.peers]);

  const versionData = useMemo<VersionDatum[]>(() => {
    if (versionScope === 'inventory') {
      const total = versionSample?.summary.total ?? 0;
      const identifiedVersions: VersionDatum[] = (versionSample?.versions || []).map((entry, index) => ({
        name: entry.version,
        value: entry.count,
        sharePct: entry.sharePct,
        isDeprecated: entry.isDeprecated,
        color: entry.isDeprecated ? 'var(--danger)' : versionColors[index % versionColors.length],
      }));
      const unknown = versionSample?.summary.unknown ?? 0;
      if (unknown > 0) {
        identifiedVersions.push({
          name: 'Unknown version',
          value: unknown,
          sharePct: total > 0 ? unknown / total * 100 : 0,
          isDeprecated: false,
          isUnknown: true,
          color: 'var(--text-subtle)',
        });
      }
      return identifiedVersions;
    }

    const versionMap = new Map<string, number>();
    for (const peer of peers) {
      const ver = peer.subver || 'Unknown';
      versionMap.set(ver, (versionMap.get(ver) || 0) + 1);
    }

    return Array.from(versionMap.entries()).map(([name, value], i) => ({
      name,
      value,
      color: versionColors[i % versionColors.length],
      sharePct: peers.length > 0 ? Math.round((value / peers.length) * 10_000) / 100 : 0,
      isDeprecated: false,
    }));
  }, [peers, versionSample, versionScope]);

  const visiblePeers = useMemo(() => {
    if (versionScope !== 'direct' || !selectedVersion) return peers;
    return peers.filter((peer) => (peer.subver || 'Unknown') === selectedVersion);
  }, [peers, selectedVersion, versionScope]);

  const toggleVersionFilter = (version: string) => {
    setSelectedVersion((current) => (current === version ? null : version));
  };

  const changeVersionScope = (scope: VersionScope) => {
    setVersionScope(scope);
    setSelectedVersion(null);
  };

  const clearPeerFilters = () => {
    setSelectedVersion(null);
  };

  const inbound = peers.filter((p) => p.inbound).length;
  const outbound = peers.filter((p) => !p.inbound).length;
  const ipv6Count = peers.filter((p) => p.isIpv6).length;
  const explorerHeight =
    typeof network?.blockHeight === 'number'
      ? network.blockHeight
      : typeof network?.headerHeight === 'number'
        ? network.headerHeight
        : null;
  const peerSyncSummary = useMemo(() => {
    const counts: Record<PeerSyncState, number> = {
      'in-sync': 0,
      'minor-lag': 0,
      behind: 0,
      ahead: 0,
      unavailable: 0,
    };
    for (const peer of peers) counts[assessPeerSync(peer, explorerHeight).state] += 1;
    return counts;
  }, [explorerHeight, peers]);
  const olderDirectPeers = useMemo(
    () => peers.filter((peer) => isOlderPeerVersion(peer.subver, versionSample?.requiredVersion)).length,
    [peers, versionSample?.requiredVersion],
  );

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title"><HiOutlineGlobeAlt /> Network</h1>
        <p className="page-subtitle">Active masternode versions and direct peer health</p>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="placeholder-content" style={{ padding: '1.5rem' }}>
            <p className="text-muted">{error}</p>
          </div>
        </div>
      )}

      <div className="grid-stats" style={{ marginBottom: '1.5rem' }}>
        <div className="stat-card">
          <div className="stat-label"><HiOutlineSignal /> Connected Peers</div>
          <div className="stat-value">{loading ? '...' : network?.connections || 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><HiOutlineServerStack /> Protocol Version</div>
          <div className="stat-value">{loading ? '...' : network?.protocolversion || 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Inbound</div>
          <div className="stat-value">{loading ? '...' : inbound}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Outbound</div>
          <div className="stat-value">{loading ? '...' : outbound}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">IPv6 Peers</div>
          <div className="stat-value">{loading ? '...' : ipv6Count}</div>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: '1.5rem' }}>
          <div className="card">
            <div className="card-header network-version-header">
              <div>
                <h2 className="card-title">{versionScope === 'inventory' ? 'Active Masternode Versions' : 'Direct Peer Versions'}</h2>
                <p className="network-card-subtitle">
                  {versionScope === 'inventory'
                    ? 'Last known versions of all ENABLED + POSE_PENALTY masternodes. Percentages use the full active count.'
                    : 'Current connections reported by the explorer daemon.'}
                </p>
              </div>
              <div className="network-scope-toggle" aria-label="Version sample source">
                <button
                  type="button"
                  className={versionScope === 'inventory' ? 'active' : ''}
                  onClick={() => changeVersionScope('inventory')}
                >
                  Active masternodes
                </button>
                <button
                  type="button"
                  className={versionScope === 'direct' ? 'active' : ''}
                  onClick={() => changeVersionScope('direct')}
                >
                  Direct peers
                </button>
              </div>
            </div>

            {versionScope === 'inventory' && versionSample && (
              <div className="network-version-summary">
                <span><strong>{formatNumber(versionSample.summary.total)}</strong> active masternodes</span>
                <span>
                  <strong>{formatNumber(versionSample.summary.recommended)} ({(versionSample.summary.total > 0 ? versionSample.summary.recommended / versionSample.summary.total * 100 : 0).toFixed(1)}%)</strong>
                  v{versionSample.requiredVersion} or newer · last known
                </span>
                <span className={versionSample.summary.stale > 0 ? 'is-warning' : ''}>
                  <strong>{formatNumber(versionSample.summary.stale)}</strong> older / undated observations
                </span>
                <span><strong>{formatNumber(versionSample.summary.unknown)}</strong> unknown version</span>
              </div>
            )}

            {versionScope === 'inventory' && versionSampleQuery.isLoading ? (
              <div className="placeholder-content network-version-placeholder">
                <p className="text-muted">Loading active masternode versions...</p>
              </div>
            ) : versionScope === 'inventory' && versionSampleQuery.isError ? (
              <div className="placeholder-content network-version-placeholder">
                <p className="text-muted" role="status">Active masternode data is unavailable. Percentages are hidden until a successful refresh.</p>
              </div>
            ) : versionData.length === 0 ? (
              <div className="placeholder-content" style={{ padding: '2.5rem' }}>
                <p className="text-muted">{versionScope === 'inventory' ? 'No active masternodes in the current snapshot.' : 'No direct peer versions available.'}</p>
              </div>
            ) : (
              <div className="network-version-list">
                {versionData.map((entry) => {
                  const rowContent = (
                    <>
                      <span className="network-version-row-head">
                        <span className="mono">{entry.name}</span>
                        <span>
                          {entry.isDeprecated && <span className="badge warning">Legacy</span>}
                          <strong>{formatNumber(entry.value)}</strong>
                          <span className="text-muted">{entry.sharePct.toFixed(1)}% {versionScope === 'inventory' ? 'of active' : 'of peers'}</span>
                        </span>
                      </span>
                      <span className="network-version-track" aria-hidden="true">
                        <span
                          className={entry.isDeprecated ? 'network-version-fill deprecated' : 'network-version-fill'}
                          style={{ width: `${entry.sharePct}%`, background: entry.color }}
                        />
                      </span>
                    </>
                  );
                  // Active masternodes open in the Masternodes table, filtered to the version;
                  // direct peers are filtered in place, in the peer table below.
                  return versionScope === 'inventory' ? (
                    <Link
                      key={entry.name}
                      to={masternodesWithVersion(entry)}
                      className={`network-version-row ${entry.isUnknown ? 'unknown' : ''}`}
                      title={`${entry.sharePct.toFixed(1)}% of all active masternodes. Open them in the Masternodes table.`}
                    >
                      {rowContent}
                    </Link>
                  ) : (
                    <button
                      key={entry.name}
                      type="button"
                      className={`network-version-row ${entry.isUnknown ? 'unknown' : ''} ${selectedVersion === entry.name ? 'active' : ''}`}
                      onClick={() => toggleVersionFilter(entry.name)}
                      title={`${entry.sharePct.toFixed(1)}% of direct peers. Click to filter.`}
                      aria-pressed={selectedVersion === entry.name}
                    >
                      {rowContent}
                    </button>
                  );
                })}
              </div>
            )}
            {versionScope === 'inventory' && versionSample && (
              <div className="network-version-note">
                <p>{versionSample.summary.enabled} enabled + {versionSample.summary.posePenalty} with PoSe points.
                  {' '}Banned and inactive statuses are excluded. Active status does not prove current reachability.</p>
                <p>All known versions are counted, including older observations.
                  {' '}{versionSample.summary.fresh} of {versionSample.summary.total} active masternodes
                  {' '}reported a version within {versionSample.versionMaxAgeSeconds / 3600}h ({versionSample.summary.coveragePct.toFixed(1)}%).
                  {' '}Observation age is shown separately and does not change the version totals.</p>
                <p className={nowMs - Date.parse(versionSample.statusObservedAt) > 120_000 ? 'is-warning' : ''}>
                  Status checked <time dateTime={versionSample.statusObservedAt} title={new Date(versionSample.statusObservedAt).toLocaleString()}>{formatObservedAge(versionSample.statusObservedAt, nowMs)}</time>.
                  {' '}Page refresh: 30s. Version collection: every {Math.round(versionSample.inventoryPollSeconds)}s.
                  {' '}External monitor delays may add to this.
                  {versionSampleQuery.isFetching && ' Refreshing…'}
                </p>
              </div>
            )}
            {/* The masternodes themselves are listed on the Masternodes page, also when this summary fails. */}
            {versionScope === 'inventory' && (
              <p className="network-table-link">
                <Link to="/masternodes" className="btn btn-sm btn-secondary">
                  Open the Masternodes table
                </Link>
              </p>
            )}
            {selectedVersion && (
              <button type="button" className="btn btn-sm btn-secondary network-clear-filter" onClick={() => toggleVersionFilter(selectedVersion)}>
                Clear version filter
              </button>
            )}
          </div>
          <div className="card network-sync-card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Peer Sync Health</h2>
                <p className="network-card-subtitle">
                  Direct peers compared with the explorer node at{' '}
                  <strong className="mono">{explorerHeight != null ? formatNumber(explorerHeight) : 'unknown height'}</strong>.
                </p>
              </div>
              <span className="badge badge-accent">{formatNumber(peers.length)} direct peers</span>
            </div>

            <div className="network-sync-summary">
              <div className="network-sync-metric success">
                <strong>{formatNumber(peerSyncSummary['in-sync'])}</strong>
                <span>in sync</span>
              </div>
              <div className="network-sync-metric warning">
                <strong>{formatNumber(peerSyncSummary['minor-lag'] + peerSyncSummary.behind)}</strong>
                <span>behind explorer</span>
              </div>
              <div className="network-sync-metric accent">
                <strong>{formatNumber(peerSyncSummary.ahead)}</strong>
                <span>report ahead</span>
              </div>
              <div className="network-sync-metric muted">
                <strong>{formatNumber(peerSyncSummary.unavailable)}</strong>
                <span>no sync data</span>
              </div>
            </div>

            <div className="network-sync-details">
              <span><strong>{inbound}</strong> inbound / <strong>{outbound}</strong> outbound</span>
              <span className={olderDirectPeers > 0 ? 'is-warning' : ''}>
                <strong>{olderDirectPeers}</strong> older than v{versionSample?.requiredVersion ?? 'current'}
              </span>
            </div>
            <p className="network-sync-disclaimer">
              Height comparison is a sync signal only. It does not establish canonical chain identity during a fork.
            </p>
          </div>
      </div>

      {versionScope === 'direct' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title"><HiOutlineServerStack /> Connected Peers</h2>
            {selectedVersion && (
              <div className="network-table-actions">
                {selectedVersion && <span className="badge badge-accent">Version: {selectedVersion}</span>}
                <span className="badge">{formatNumber(visiblePeers.length)} visible peers</span>
                <button type="button" className="btn btn-sm btn-secondary" onClick={clearPeerFilters}>Show all</button>
              </div>
            )}
          </div>
          {loading ? (
            <div className="network-table-placeholder">Loading peers...</div>
          ) : error && peers.length === 0 ? (
            <div className="network-table-placeholder">{error}</div>
          ) : peers.length === 0 ? (
            <div className="network-table-placeholder">No peer data available</div>
          ) : visiblePeers.length === 0 ? (
            <div className="network-table-placeholder">No peers match the selected filter.</div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Address</th><th>Country</th><th>IP</th><th>Version</th><th>Type</th><th>Height</th><th>Sync</th><th>Connected</th><th>Ping</th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePeers.map((peer, i) => (
                    <tr key={`${peer.addr}-${i}`}>
                      {(() => {
                        const sync = assessPeerSync(peer, explorerHeight);
                        const badgeClass = sync.state === 'in-sync'
                          ? 'success'
                          : sync.state === 'minor-lag' || sync.state === 'behind'
                            ? 'warning'
                            : sync.state === 'ahead'
                              ? 'badge-accent'
                              : '';
                        return <>
                      <td className="mono network-peer-address">{peer.addr}</td>
                      <td>
                        <span className="mono network-country-cell">
                          <span aria-hidden>{countryCodeToFlag(peer.countryCode || '')}</span>
                          <span>{peer.countryName || 'Unknown'}</span>
                        </span>
                      </td>
                      <td><span className={`badge ${peer.isIpv6 ? 'warning' : 'success'}`}>{peer.isIpv6 ? 'IPv6' : 'IPv4'}</span></td>
                      <td className="mono network-peer-version">{peer.subver}</td>
                      <td><span className={`badge ${peer.inbound ? '' : 'success'}`}>{peer.inbound ? 'Inbound' : 'Outbound'}</span></td>
                      <td className="mono">{typeof peer.synced_blocks === 'number' ? formatNumber(peer.synced_blocks) : 'N/A'}</td>
                      <td><span className={`badge ${badgeClass}`}>{sync.label}</span></td>
                      <td className="text-muted">{typeof peer.conntime === 'number' ? formatAge(peer.conntime) : 'N/A'}</td>
                      <td className="mono">{typeof peer.pingtime === 'number' ? `${peer.pingtime.toFixed(3)}s` : 'N/A'}</td>
                        </>;
                      })()}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
