import { memo, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchStats, fetchSyncStatus } from '../../services/api';
import { useAutoRefresh } from '../../context/AutoRefreshContext';
import { usePageVisibility } from '../../hooks/usePageVisibility';
import { formatNumber } from '../../utils/formatters';
import { getHeaderStatus } from '../../utils/headerStatus';
import type { DashboardOverviewView, StatsView } from '../../types/api';

interface HeaderStatusChipsProps {
  compact?: boolean;
}

const STATUS_CLOCK_INTERVAL_MS = 30_000;

function formatMetric(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return formatNumber(value);
}

function HeaderStatusChips({ compact = false }: HeaderStatusChipsProps) {
  const queryClient = useQueryClient();
  const isPageVisible = usePageVisibility();
  const { realtimeConnected } = useAutoRefresh();

  const cachedDashboardStats = queryClient.getQueryData<DashboardOverviewView | undefined>([
    'dashboard-overview',
  ])?.stats;

  const statsQuery = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
    initialData: cachedDashboardStats as StatsView | undefined,
    staleTime: 60_000,
    refetchInterval: isPageVisible ? 60_000 : false,
  });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const syncQuery = useQuery({
    // Keep confirmed RPC health separate from partial websocket sync updates.
    queryKey: ['header-sync-status'],
    queryFn: fetchSyncStatus,
    staleTime: 15_000,
    refetchInterval: isPageVisible ? 30_000 : false,
  });

  useEffect(() => {
    if (!isPageVisible) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), STATUS_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [isPageVisible]);

  const stats = statsQuery.data;
  const syncedHeight = syncQuery.data?.lastSyncedHeight;
  const height = formatMetric(typeof syncedHeight === 'number' && syncedHeight >= 0 ? syncedHeight : stats?.blockHeight);
  const peers = formatMetric(stats?.connections);
  const masternodes = formatMetric(stats?.masternodes);
  const stakers = formatMetric(stats?.stakingWallets);
  const status = getHeaderStatus(stats, syncQuery.data, syncQuery.dataUpdatedAt, nowMs, realtimeConnected);

  return (
    <div className={`header-status-chips ${compact ? 'compact' : ''}`} aria-label="Network status">
      {/* The colour follows the health of the status ("Polling" is healthy); "long-label" marks any
          word longer than "Live", which leaves less room beside it on a narrow screen. */}
      <div
        className={`status-chip status-chip-live ${status.healthy ? 'online' : 'degraded'}${status.label === 'Live' ? '' : ' long-label'}`}
        title={status.title}
      >
        <span className="status-dot" aria-hidden="true" />
        <span className="status-chip-label">{status.label}</span>
      </div>

      <div className="status-chip status-chip-height" title="Current indexed block height">
        <span className="status-chip-label">Height</span>
        <strong className="status-chip-value">{height}</strong>
      </div>

      <div className="status-chip status-chip-peers">
        <span className="status-chip-label">Peers</span>
        <strong className="status-chip-value">{peers}</strong>
      </div>

      <div className="status-chip status-chip-masternodes">
        <span className="status-chip-label">MN</span>
        <strong className="status-chip-value">{masternodes}</strong>
      </div>

      <div className="status-chip status-chip-stakers" title="Active staking wallets in the last 24 hours">
        <span className="status-chip-label">Stakers</span>
        <strong className="status-chip-value">{stakers}</strong>
      </div>
    </div>
  );
}

export default memo(HeaderStatusChips);

