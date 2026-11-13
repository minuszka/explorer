import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { OperatorDiagnosisPanel, nodePermalink } from '../components/OperatorDiagnosisPanel';
import { BannedByPanel } from '../components/BannedByPanel';
import TimeText from '../components/ui/TimeText';
import { isProTxHash, masternodePath } from '../utils/routes';
import {
  HiOutlineFire,
  HiOutlineBolt,
  HiOutlineGlobeAlt,
  HiOutlineExclamationTriangle,
  HiOutlineArrowPath,
  HiOutlineClock,
} from 'react-icons/hi2';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceArea,
  ReferenceLine,
} from 'recharts';
import { fetchBanWaveAnalysis } from '../services/api';
import { BanTypeShareKpi } from '../components/BanTypeShareKpi';
import { useChartAnimation } from '../utils/chartAnimation';
import { formatNumber, truncateHash } from '../utils/formatters';
import type { BanWaveAnalysisView, BanWaveDetail } from '../types/api';
import { usePageVisibility } from '../hooks/usePageVisibility';
import './PageStyles.css';
import './MasternodeHealthPage.css';
import './BanDetectionPage.css';

type WindowKey = 'q60' | '24h' | '7d' | '30d' | '90d';
type TimelineMode = 'fresh' | 'recovered' | 'still' | 'all';

const WINDOW_OPTIONS: { key: WindowKey; label: string; hours: number }[] = [
  { key: 'q60', label: 'Since Q60', hours: 2160 },
  { key: '24h', label: '24h', hours: 24 },
  { key: '7d', label: '7 days', hours: 168 },
  { key: '30d', label: '30 days', hours: 720 },
  { key: '90d', label: '90 days', hours: 2160 },
];


const SEVERITY_COLOR: Record<BanWaveDetail['severity'], string> = {
  low: '#888',
  moderate: '#f5a623',
  high: '#ef4d56',
  critical: '#9b1b22',
};

const SEVERITY_RANK: Record<BanWaveDetail['severity'], number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const SEVERITY_BAND_OPACITY: Record<BanWaveDetail['severity'], number> = {
  low: 0.03,
  moderate: 0.05,
  high: 0.07,
  critical: 0.1,
};

function severityClass(s: BanWaveDetail['severity']): string {
  return `bd-sev bd-sev-${s}`;
}

function bucketToTimestampMs(bucket: string): number {
  const direct = new Date(bucket).getTime();
  if (Number.isFinite(direct)) return direct;
  const asDay = new Date(`${bucket}T00:00:00Z`).getTime();
  if (Number.isFinite(asDay)) return asDay;
  return 0;
}

function formatBucket(bucket: string, mode: 'hour' | 'day' | '15min' | 'auto'): string {
  if (mode === 'day' || bucket.length === 10) return bucket.slice(5);
  const d = new Date(bucket);
  if (mode === '15min') {
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}h`;
}

function humanDuration(sec: number | null): string {
  if (sec == null) return '-';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round((sec / 3600) * 10) / 10}h`;
  return `${Math.round((sec / 86400) * 10) / 10}d`;
}

function timelineModeDescription(mode: TimelineMode): string {
  if (mode === 'fresh') return 'Confirmed ban events in the selected period';
  if (mode === 'recovered') return 'Recovery events for previously detected drops; historical bans remain visible';
  if (mode === 'still') return 'Historical drop events whose nodes are still currently POSE_BANNED';
  return 'All historical drop events plus recovery markers; not just current state';
}

function waveNodeStatusLabel(status?: string): string {
  if (status === 'recovered') return 'RECOVERED';
  if (status === 'still_banned') return 'STILL BANNED';
  return 'BANNED';
}

export function BanDetectionPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [windowKey, setWindowKey] = useState<WindowKey>('q60');
  const [windowMinutes, setWindowMinutes] = useState(30);
  const [minNodes, setMinNodes] = useState(3);
  const [timelineMode, setTimelineMode] = useState<TimelineMode>('fresh');
  const [paused, setPaused] = useState<boolean>(false);
  const [focusChart, setFocusChart] = useState(false);
  const nodeFilter = searchParams.get('node') ?? '';
  const setNodeFilter = (value: string) => { const next = new URLSearchParams(searchParams);
    next.delete('ban');
    if (value) next.set('node', value); else next.delete('node');
    setSearchParams(next, { replace: true }); };
  const [repeatsOnly, setRepeatsOnly] = useState(false);
  const isPageVisible = usePageVisibility();
  const chartAnimation = useChartAnimation();

  const win = WINDOW_OPTIONS.find((w) => w.key === windowKey) ?? WINDOW_OPTIONS[1];

  const { data: response, isError, isLoading, isFetching, refetch } = useQuery<BanWaveAnalysisView>({
    queryKey: ['ban-waves', windowKey, win.hours, windowMinutes, minNodes],
    queryFn: () => fetchBanWaveAnalysis({ hours: win.hours, windowMinutes, minNodes, scope: windowKey === 'q60' ? 'q60' : 'rolling' }),
    refetchInterval: paused || !isPageVisible ? false : 90_000,
    staleTime: 45_000,
  });
  const data = isError ? undefined : response;
  const trackedNodes = data?.trackedNodes ?? [];
  const visibleNodes = trackedNodes.filter((node) => (!repeatsOnly || node.banCount > 1) &&
    `${node.nodeId} ${node.proTxHash ?? ''} ${node.service}`.toLowerCase().includes(nodeFilter.toLowerCase()));
  const periodLabel = windowKey === 'q60' ? 'Since Q60 activation' : `Selected period: ${win.label}`;
  const eventCount = trackedNodes.reduce((sum, node) => sum + node.banCount, 0);

  const timelineChartData = useMemo(() => {
    if (!data) return [];
    const timeline = data.timelineModes?.[timelineMode] ?? data.timeline;
    if (!focusChart) return timeline;
    if (timeline.length === 0) return [];
    const firstActive = timeline.findIndex((point) => point.waveBans > 0 || point.isolatedBans > 0 || (point.recovered ?? 0) > 0 || (point.stillBanned ?? 0) > 0);
    if (firstActive < 0) return timeline;

    let lastActive = timeline.length - 1;
    while (lastActive >= 0) {
      const point = timeline[lastActive];
      if (point.waveBans > 0 || point.isolatedBans > 0 || (point.recovered ?? 0) > 0 || (point.stillBanned ?? 0) > 0) break;
      lastActive -= 1;
    }

    const padding = Math.min(8, Math.max(2, Math.round(timeline.length * 0.08)));
    const start = Math.max(0, firstActive - padding);
    const end = Math.min(timeline.length - 1, lastActive + padding);
    return timeline.slice(start, end + 1);
  }, [data, timelineMode, focusChart]);

  const waveBands = useMemo(() => {
    if (!data || timelineChartData.length === 0) return [] as Array<{
      x1: string;
      x2: string;
      severity: BanWaveDetail['severity'];
      opacity: number;
    }>;

    if (Array.isArray(data.waveBands) && data.waveBands.length > 0) {
      const timelineSet = new Set(timelineChartData.map((point) => point.bucket));
      return data.waveBands
        .filter((band) => timelineSet.has(band.x1) || timelineSet.has(band.x2))
        .map((band) => ({
          x1: band.x1,
          x2: band.x2,
          severity: band.severity,
          opacity: SEVERITY_BAND_OPACITY[band.severity],
        }));
    }

    const bucketTimes = timelineChartData.map((point) => bucketToTimestampMs(point.bucket));
    const intervals: Array<{ start: number; end: number; severity: BanWaveDetail['severity'] }> = [];

    for (const wave of data.waves) {
      const startMs = new Date(wave.startedAt).getTime();
      const endMs = new Date(wave.endedAt).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      if (endMs < bucketTimes[0] || startMs > bucketTimes[bucketTimes.length - 1]) continue;

      let startIdx = 0;
      for (let i = bucketTimes.length - 1; i >= 0; i -= 1) {
        if (bucketTimes[i] <= startMs) {
          startIdx = i;
          break;
        }
      }

      let endIdx = bucketTimes.length - 1;
      for (let i = 0; i < bucketTimes.length; i += 1) {
        if (bucketTimes[i] >= endMs) {
          endIdx = i;
          break;
        }
      }

      if (endIdx < startIdx) continue;
      intervals.push({ start: startIdx, end: endIdx, severity: wave.severity });
    }

    if (intervals.length === 0) return [];
    intervals.sort((a, b) => a.start - b.start);

    const merged: Array<{ start: number; end: number; severity: BanWaveDetail['severity'] }> = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (!last || interval.start > last.end + 1) {
        merged.push({ ...interval });
        continue;
      }
      last.end = Math.max(last.end, interval.end);
      if (SEVERITY_RANK[interval.severity] > SEVERITY_RANK[last.severity]) {
        last.severity = interval.severity;
      }
    }

    return merged.map((band) => ({
      x1: timelineChartData[band.start]?.bucket ?? timelineChartData[0].bucket,
      x2: timelineChartData[band.end]?.bucket ?? timelineChartData[timelineChartData.length - 1].bucket,
      severity: band.severity,
      opacity: SEVERITY_BAND_OPACITY[band.severity],
    }));
  }, [data, timelineChartData]);

  const timelineFocused = Boolean(data && timelineChartData.length > 0 && timelineChartData.length < data.timeline.length);
  const activationMs = data?.analysisScope?.activatedAt ? Date.parse(data.analysisScope.activatedAt) : null;
  const bucketDurationMs = data?.bucket === 'day' ? 86_400_000 : data?.bucket === 'hour' ? 3_600_000 : 900_000;
  const activationBucket = activationMs == null ? undefined : timelineChartData.find((point) =>
    point.timestamp * 1000 <= activationMs && point.timestamp * 1000 + bucketDurationMs > activationMs)?.bucket;

  return (
    <div className="page-container bd-page">
      <section className="bd-hero-card">
        <header className="bd-hero-header">
          <div className="bd-hero-copy">
            <div className="bd-hero-kicker">Monitoring</div>
          <h1 className="page-title">
            <HiOutlineFire style={{ verticalAlign: '-0.15em', marginRight: '0.4rem' }} />
            PoSe Watch
          </h1>
          <p className="page-subtitle">
            Current masternode state and confirmed PoSe ban history. Compare events after
            the Q60 consensus activation at block 144888 with earlier periods.
          </p>
        </div>
        <div className="bd-header-controls">
          <div className="bd-chip-group bd-chip-group-range" role="tablist" aria-label="Time window">
            {WINDOW_OPTIONS.map((w) => (
              <button
                key={w.key}
                role="tab"
                aria-selected={windowKey === w.key}
                className={`bd-chip-btn ${windowKey === w.key ? 'active' : ''}`}
                onClick={() => setWindowKey(w.key)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <div className="bd-header-actions">
            <button
              type="button"
              className="bd-icon-btn"
              onClick={() => refetch()}
              disabled={isFetching}
              title="Refresh now"
              aria-label="Refresh"
            >
              <HiOutlineArrowPath className={isFetching ? 'spin' : ''} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className={`bd-icon-btn ${paused ? 'active' : ''}`}
              onClick={() => setPaused((p) => !p)}
              title={paused ? 'Auto-refresh paused' : 'Pause auto-refresh'}
              aria-label={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
            >
              <span>{paused ? 'Resume' : 'Pause'}</span>
            </button>
          </div>
        </div>
        </header>
        <div className="bd-monitor-status" role="status">
          {isError ? 'Ban analysis unavailable. Refresh to retry.' : isLoading ? 'Loading ban analysis…' : data ? <>
            Updated <TimeText value={data.generatedAt} /> · {paused ? 'Auto-refresh paused' : 'Refresh every 90s while visible'}
            {' · '}{data.rpcAvailable ? 'Live RPC available' : 'Live RPC unavailable — current counts unknown'}
            {data.dataStatus === 'stale' && ' · Cached historical data — refresh failed'}
          </> : 'No data available'}
        </div>
        {data?.analysisScope && <p className="mnh-panel-sub">
          {periodLabel} · History from <TimeText value={data.analysisScope.from} />
          {data.analysisScope.historyLimited && ' · Limited to the retained history window'}
          {data.analysisScope.unclassifiedEvents > 0 && ` · ${data.analysisScope.unclassifiedEvents} events excluded: ban block unknown`}
        </p>}
      </section>

      {/* KPI strip */}
      <h2 className="mnh-panel-title bd-section-title">Current registered masternodes</h2>
      <section className="mnh-stats-grid bd-current-stats">
        <KPI icon={<HiOutlineGlobeAlt />} label="Registered" value={data?.rpcAvailable && data.dataStatus !== 'stale' ? formatNumber(data.registeredTotal) : 'Unknown'} sub="Current daemon snapshot" />
        <KPI icon={<HiOutlineBolt />} label="Active" value={data?.rpcAvailable && data.dataStatus !== 'stale' ? formatNumber(data.currentValid) : 'Unknown'} sub="ENABLED + POSE_PENALTY" />
        <KPI icon={<HiOutlineFire />} label="Currently banned" value={data?.rpcAvailable && data.dataStatus !== 'stale' ? formatNumber(data.currentPoseBanned) : 'Unknown'} sub="Includes bans from earlier periods" />
        <KPI icon={<HiOutlineExclamationTriangle />} label="Active with penalty" value={data?.rpcAvailable && data.dataStatus !== 'stale' ? formatNumber(data.currentPosePenalty) : 'Unknown'} sub="Already included in Active" />
      </section>
      <h2 className="mnh-panel-title bd-section-title">{periodLabel}</h2>
      <section className="mnh-stats-grid">
        <KPI
          icon={<HiOutlineBolt />}
          label="Affected nodes"
          value={data ? formatNumber(trackedNodes.length) : '-'}
          sub={data ? `${formatNumber(eventCount)} distinct ban events` : ''}
        />
        <KPI
          icon={<HiOutlineFire />}
          label="Detected waves"
          value={data ? formatNumber(data.kpis.windowWaveCount) : '-'}
          sub={`At least ${minNodes} unique nodes / ${windowMinutes}m`}
        />
        <KPI
          icon={<HiOutlineExclamationTriangle />}
          label="Largest wave"
          value={data ? `${data.kpis.windowLargestWave} nodes` : '-'}
          sub="Within the selected period"
        />
        <KPI
          icon={<HiOutlineGlobeAlt />}
          label="Repeatedly banned"
          value={data ? formatNumber(trackedNodes.filter((node) => node.banCount > 1).length) : '-'}
          sub="Two or more distinct ban blocks"
        />
        <KPI
          icon={<HiOutlineClock />}
          label="Avg gap between waves"
          value={data ? humanDuration(data.kpis.meanTimeBetweenWavesSec) : '-'}
          sub="Lower = more clustered"
        />
        <BanTypeShareKpi hours={win.hours} since={data?.analysisScope?.from}
          fromHeight={windowKey === 'q60' ? data?.analysisScope?.activationHeight : undefined}
          enabled={!!data && !isError && data.dataStatus !== 'stale'} paused={paused || !isPageVisible} />
      </section>

      {/* Timeline ComposedChart */}
      <section className="mnh-panel">
        <div className="bd-analysis-controls">
          <label>Wave window
            <select value={windowMinutes} onChange={(event) => setWindowMinutes(Number(event.target.value))}>
              {[15, 30, 60, 120].map((value) => <option key={value} value={value}>{value} minutes</option>)}
            </select>
          </label>
          <label>Minimum nodes
            <select value={minNodes} onChange={(event) => setMinNodes(Number(event.target.value))}>
              {[2, 3, 5, 10, 15].map((value) => <option key={value} value={value}>{value} nodes</option>)}
            </select>
          </label>
          <label className="bd-check"><input type="checkbox" checked={focusChart} onChange={(event) => setFocusChart(event.target.checked)} /> Focus on events</label>
          <Link to="/devtools/network-noise">Network noise telemetry</Link>
        </div>
        <div className="mnh-panel-header">
          <h2 className="mnh-panel-title">
            <HiOutlineClock /> Drop event history
          </h2>
          <div className="bd-timeline-toolbar">
            <span className="mnh-panel-sub">
              {timelineModeDescription(timelineMode)}
              {timelineFocused ? ' - focused on active interval' : ''}
            </span>
            <div className="bd-chip-group" role="tablist" aria-label="Timeline mode">
              <button
                type="button"
                role="tab"
                aria-selected={timelineMode === 'fresh'}
                className={`bd-chip-btn ${timelineMode === 'fresh' ? 'active' : ''}`}
                onClick={() => setTimelineMode('fresh')}
              >
                Ban events
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={timelineMode === 'recovered'}
                className={`bd-chip-btn ${timelineMode === 'recovered' ? 'active' : ''}`}
                onClick={() => setTimelineMode('recovered')}
              >
                Recovered
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={timelineMode === 'still'}
                className={`bd-chip-btn ${timelineMode === 'still' ? 'active' : ''}`}
                onClick={() => setTimelineMode('still')}
              >
                Still banned
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={timelineMode === 'all'}
                className={`bd-chip-btn ${timelineMode === 'all' ? 'active' : ''}`}
                onClick={() => setTimelineMode('all')}
              >
                All tracked
              </button>
            </div>
          </div>
        </div>
        <p className="mnh-panel-sub">Times on this chart are UTC. Counts represent events; one node can be banned more than once. An empty interval means no recorded events.</p>
        <div style={{ width: '100%', height: 360 }}>
          {data && timelineChartData.length > 0 && (
            <ResponsiveContainer>
              <ComposedChart data={timelineChartData} margin={{ top: 8, right: 8, bottom: 8, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" opacity={0.4} />
                <XAxis
                  dataKey="bucket"
                  stroke="var(--text-color-muted)"
                  tickFormatter={(b) => formatBucket(String(b), data.bucket)}
                  fontSize={11}
                  minTickGap={24}
                />
                <YAxis
                  yAxisId="left"
                  stroke="var(--text-color-muted)"
                  fontSize={11}
                  allowDecimals={false}
                  width={34}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="var(--text-color-muted)"
                  fontSize={11}
                  allowDecimals={false}
                  width={34}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: 'var(--text-color)',
                  }}
                  labelStyle={{ color: 'var(--text-color)' }}
                  itemStyle={{ color: 'var(--text-color)' }}
                  labelFormatter={(b) => formatBucket(String(b), data.bucket)}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {activationBucket && <ReferenceLine
                  yAxisId="left" x={activationBucket} stroke="#2f8fff" strokeDasharray="4 4"
                  label={{ value: 'Q60 · 144888', position: 'insideTopLeft', fill: '#2f8fff', fontSize: 11 }}
                />}
                {waveBands.map((band, idx) => (
                  <ReferenceArea
                    key={`${band.x1}-${band.x2}-${idx}`}
                    yAxisId="left"
                    x1={band.x1}
                    x2={band.x2}
                    fill={SEVERITY_COLOR[band.severity]}
                    fillOpacity={band.opacity}
                  />
                ))}
                {timelineMode === 'recovered' ? (
                  <Bar
                    yAxisId="left"
                    dataKey="recovered"
                    fill="var(--success)"
                    name="Recovery events"
                    maxBarSize={22}
                    {...chartAnimation}
                  />
                ) : timelineMode === 'still' ? (
                  <Bar
                    yAxisId="left"
                    dataKey="stillBanned"
                    fill="#ef4d56"
                    name="Still banned drop events"
                    maxBarSize={22}
                    {...chartAnimation}
                  />
                ) : (
                  <>
                    <Bar
                      yAxisId="left"
                      dataKey="isolatedBans"
                      stackId="bans"
                      fill="#888"
                      name="Isolated drop events"
                      maxBarSize={22}
                      {...chartAnimation}
                    />
                    <Bar
                      yAxisId="left"
                      dataKey="waveBans"
                      stackId="bans"
                      fill="#ef4d56"
                      name="Wave drop events"
                      maxBarSize={22}
                      {...chartAnimation}
                    />
                    {timelineMode === 'all' && (
                      <Bar
                        yAxisId="left"
                        dataKey="recovered"
                        fill="var(--success)"
                        name="Recovery events"
                        maxBarSize={22}
                        {...chartAnimation}
                      />
                    )}
                  </>
                )}
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="cumulative"
                  stroke="#2f8fff"
                  strokeWidth={2}
                  dot={false}
                  name={timelineMode === 'recovered' ? 'Cumulative recovery events' : 'Cumulative drop events'}
                  {...chartAnimation}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className="mnh-panel bd-node-panel">
        <div className="mnh-panel-header">
          <h2 className="mnh-panel-title">{repeatsOnly ? 'Repeatedly banned nodes' : 'All affected nodes'}</h2>
          <span className="mnh-panel-sub">{periodLabel} · Most repeats first</span>
        </div>
        <div className="bd-analysis-controls">
          <label>Find node<input type="search" placeholder="Service IP or node identity" value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value)} /></label>
          <label className="bd-check"><input type="checkbox" checked={repeatsOnly} onChange={(event) => setRepeatsOnly(event.target.checked)} /> Repeated bans only</label>
        </div>
        <p className="mnh-panel-sub">Distinct ban blocks per masternode identity, including isolated bans. Current state is independent of historical recovery.</p>
        <div className="mnh-table-wrap">
          <table className="mnh-table">
            <thead><tr><th>Node / Service</th><th>Ban events</th><th>Last ban block</th><th>Last event</th><th>Recorded recovery</th><th>Current state</th><th>Penalty</th><th>Ban cause</th></tr></thead>
            <tbody>{visibleNodes.map((node) => <tr key={node.proTxHash || node.nodeId}>
              <td className="mnh-mono"><Link to={nodePermalink(node.proTxHash || node.service || node.nodeId)}>{node.service || 'Unknown service'}</Link>{isProTxHash(node.proTxHash)
                ? <div className="mnh-meta-line"><Link to={masternodePath(node.proTxHash)} title={`Open the masternode page: ${node.proTxHash}`}>{truncateHash(node.proTxHash, 8)}</Link></div>
                : <div title={node.proTxHash || node.nodeId} className="mnh-meta-line">{truncateHash(node.proTxHash || node.nodeId, 8)}</div>}</td>
              <td>{node.banCount}</td>
              <td>{node.lastBanHeight != null ? <Link to={`/block/${node.lastBanHeight}`}>{formatNumber(node.lastBanHeight)}</Link> : 'Unknown'}</td>
              <td><TimeText value={node.lastBanAt} /></td>
              <td><TimeText value={node.recoveredAt} fallback="Not recorded" /></td>
              <td>{data?.rpcAvailable && data.dataStatus !== 'stale' ? node.currentStatus ?? 'Unknown / not registered' : 'Unknown'}</td>
              <td>{data?.rpcAvailable && data.dataStatus !== 'stale' ? node.currentPenalty ?? 'Unknown' : 'Unknown'}</td>
              <td><button type="button" className="bd-ban-evidence"
                disabled={!/^[a-fA-F0-9]{64}$/.test(node.proTxHash ?? '') || !node.lastBanHeight || node.lastBanHeight < 1}
                onClick={() => { const next = new URLSearchParams(searchParams); next.set('node', node.proTxHash!.toLowerCase());
                  next.set('ban', String(node.lastBanHeight)); setSearchParams(next); }}>Ban evidence</button></td>
            </tr>)}</tbody>
          </table>
        </div>
        {visibleNodes.length === 0 && <div className="mnh-empty">{isLoading ? 'Loading…' : !data ? 'Node history unavailable.' : repeatsOnly ? 'No repeated bans match this period and search. Uncheck “Repeated bans only” to view isolated events.' : 'No confirmed bans match this period and search.'}</div>}
      </section>

      <OperatorDiagnosisPanel filter={nodeFilter} paused={paused || !isPageVisible} />
      <BannedByPanel identity={nodeFilter} height={searchParams.get('ban') ?? ''} paused={paused || !isPageVisible} />

      {/* Wave list */}
      <section className="mnh-panel">
        <div className="mnh-panel-header">
          <h2 className="mnh-panel-title">
            <HiOutlineFire /> Detected Waves ({data?.waves.length ?? 0})
          </h2>
          <span className="mnh-panel-sub">
            {periodLabel} · Newest first · Severity combines affected nodes, concentration and speed. Correlation does not establish cause.
          </span>
        </div>

        {(!data || data.waves.length === 0) && (
          <div className="mnh-empty" style={{ padding: '2rem' }}>
            {isLoading
              ? 'Loading...'
              : !data ? 'Wave history unavailable.' : 'No wave matched the current thresholds. Adjust Minimum nodes or Wave window above; isolated bans remain in All affected nodes.'}
          </div>
        )}

        {data?.waves.map((w) => (
          <WaveCard key={w.id} wave={w} />
        ))}
      </section>
    </div>
  );
}

function KPI({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="mnh-stat-card">
      <div className="mnh-stat-icon">{icon}</div>
      <div className="mnh-stat-body">
        <div className="mnh-stat-label">{label}</div>
        <div className="mnh-stat-value">{value}</div>
        {sub && <div className="mnh-stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

function WaveCard({ wave }: { wave: BanWaveDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bd-wave-card">
      <button
        type="button"
        className="bd-wave-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={severityClass(wave.severity)}>{wave.severity}</span>
        <span className="bd-wave-title">
          {wave.totalNodes} nodes | {wave.stillBannedCount ?? 0} still banned | {wave.recoveredCount ?? 0} recovered | {humanDuration(wave.durationSeconds)}
        </span>
        <span className="bd-wave-meta">
          <TimeText value={wave.startedAt} /> |{' '}
          {wave.uniqueCountries} countr{wave.uniqueCountries === 1 ? 'y' : 'ies'} |{' '}
          {wave.uniqueIps} IP{wave.uniqueIps === 1 ? '' : 's'} |{' '}
          {wave.uniqueOperators} operator{wave.uniqueOperators === 1 ? '' : 's'} | versions: {(wave.versions || []).slice(0, 3).join(', ') || 'not observed'}
          {(wave.asnClusters?.[0]?.nodes ?? 0) >= 2 && <> | largest ASN cluster: {wave.asnClusters![0].nodes} nodes on AS{wave.asnClusters![0].asn}</>}
        </span>
        <span className="bd-wave-score">score {wave.severityScore}</span>
        <span className="bd-wave-toggle">{open ? '-' : '+'}</span>
      </button>
      {open && (
        <div className="bd-wave-body">
          <div className="bd-wave-asn">
            {(wave.asnClusters ?? []).filter(cluster => cluster.nodes >= 2).map(cluster =>
              <p key={cluster.asn}>{cluster.nodes} affected nodes share AS{cluster.asn}
                {cluster.organization ? ` (${cluster.organization})` : ''} · {cluster.sharePct}% of this wave.</p>)}
            <p className="mnh-meta-line">ASN enrichment: {wave.asnKnownNodes ?? 'Unknown'} known,
              {' '}{wave.asnUnknownNodes ?? 'Unknown'} unknown. Shared ASN is correlation, not proof of a shared operator or ban cause.</p>
          </div>
          <div className="bd-wave-tags">
            {wave.countries.map((c) => (
              <span key={c} className="bd-country-tag">
                {c}
              </span>
            ))}
          </div>
          <div className="mnh-table-wrap">
            <table className="mnh-table">
              <thead>
                <tr>
                  <th>Detected</th>
                  <th>Ban block</th>
                  <th>Recovered</th>
                  <th>Status</th>
                  <th>Node</th>
                  <th>Transition</th>
                  <th>IP / Service</th>
                  <th>Wallet version</th>
                  <th>Country</th>
                  <th>Operator</th>
                  <th>Payout</th>
                </tr>
              </thead>
              <tbody>
                {wave.nodes.map((n) => (
                  <tr key={n.nodeId + n.atIso}>
                    <td className="mnh-mono">
                      <TimeText value={n.detectedAt || n.atIso} />
                    </td>
                    <td>{n.poseBanHeight != null ? <Link to={`/block/${n.poseBanHeight}`}>{formatNumber(n.poseBanHeight)}</Link> : 'Unknown'}</td>
                    <td className="mnh-mono">
                      <TimeText value={n.recoveredAt} fallback="not recovered yet" />
                    </td>
                    <td>
                      <span className={`bd-status-badge bd-status-${n.status || 'banned'}`}>
                        {waveNodeStatusLabel(n.status)}
                      </span>
                    </td>
                    <td className="mnh-mono" title={n.nodeId}>
                      {truncateHash(n.proTxHash || n.nodeId, 6)}
                    </td>
                    <td>
                      <span className="badge">{n.recoveryTransition || `${n.previousStatus || 'POSE_BAN_HEIGHT'} -> POSE_BANNED`}</span>
                    </td>
                    <td className="mnh-mono">{n.service || n.ip || '-'}</td>
                    <td>
                      <span className="badge badge-accent">
                        {n.walletVersion || (typeof n.protocolVersion === 'number' ? `protocol ${n.protocolVersion}` : 'not observed')}
                      </span>
                      {n.versionObservedAt && (
                        <div className="mnh-meta-line">Last observed <TimeText value={n.versionObservedAt} />{new Date(n.versionObservedAt).getTime() > new Date(n.atIso).getTime() ? ' · after this event' : ''}</div>
                      )}
                      <div className="mnh-meta-line">Last-known version; not proof of ban cause</div>
                    </td>
                    <td>
                      {n.countryCode !== 'UNK' ? n.countryCode : '-'}
                      <div className="mnh-meta-line">{n.countryName}</div>
                    </td>
                    <td className="mnh-mono">
                      {n.operatorPubkey ? truncateHash(n.operatorPubkey, 6) : '-'}
                    </td>
                    <td>
                      {n.payoutAddress ? (
                        <Link className="mnh-link mnh-mono" to={`/address/${n.payoutAddress}`}>
                          {truncateHash(n.payoutAddress, 6)}
                        </Link>
                      ) : (
                        <span className="mnh-meta-line">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default BanDetectionPage;
