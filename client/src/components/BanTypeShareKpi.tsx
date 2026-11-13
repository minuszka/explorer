import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HiOutlineChartPie } from 'react-icons/hi2';
import { fetchPoseChainSummary } from '../services/api';
import { getBanTypeShare } from '../utils/banTypeShare';
import TimeText from './ui/TimeText';

export function BanTypeShareKpi({ hours, since, fromHeight, enabled, paused }: {
  hours: number; since?: string; fromHeight?: number; enabled: boolean; paused: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ['ban-type-share', hours, since, fromHeight],
    queryFn: () => fetchPoseChainSummary({ hours, since, fromHeight }), enabled,
    refetchInterval: paused ? false : 90000, retry: false,
  });
  const age = query.data ? Math.max(now, Date.now()) - Date.parse(query.data.generatedAt) : Infinity;
  const data = enabled && !query.isError && age >= -5000 && age <= 180000 ? query.data : undefined;
  const share = getBanTypeShare(data);
  const usable = data?.status === 'ready' && data.penaltyCoverage.enabled;
  return <article className="mnh-stat-card bd-type-share" aria-label="Ban attribution by quorum type">
    <div className="mnh-stat-icon"><HiOutlineChartPie /></div>
    <div className="mnh-stat-body">
      <div className="mnh-stat-label">Q400_60 (Type 2) ban share</div>
      <div className="mnh-stat-value">{share.type2Pct === null ? 'Unknown' : `${share.type2Pct.toFixed(1)}%`}</div>
      <div className="mnh-stat-sub">{share.q60Pct === null ? 'No verified ban attribution in this window'
        : `Q60: ${share.q60Pct.toFixed(1)}% · Other types: ${share.other} bans`}</div>
      {usable && <div className="mnh-stat-sub">
        {share.total} verified ban events · {share.unknownCommitments} commitments with unknown penalties
        <br />{data.penaltyCoverage.verifiedBlocks}/{data.penaltyCoverage.commitmentBlocks} commitment blocks verified
        <br />{data.coverage.caughtUp ? 'Collected range caught up' : 'Partial collected range'}
        {' · '}height {data.coverage.startHeight}–{data.coverage.confirmedThroughHeight}
      </div>}
      <div className="mnh-stat-sub">Share of attributed bans only; unknown penalties are excluded. Membership alone is not ban evidence.</div>
      {data && <div className="mnh-stat-sub">Updated <TimeText value={data.generatedAt} /></div>}
      <button type="button" className="bd-icon-btn" disabled={!enabled || query.isFetching}
        onClick={() => void query.refetch()}>Refresh attribution</button>
    </div>
  </article>;
}
