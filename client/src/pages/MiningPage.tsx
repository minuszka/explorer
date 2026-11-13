import {
  HiOutlineCpuChip,
  HiOutlineArrowTrendingUp,
  HiOutlineClock,
  HiOutlineBanknotes,
  HiOutlineServerStack,
  HiOutlineWallet,
  HiOutlineCalculator,
  HiOutlineChartBarSquare,
  HiOutlineLockClosed,
} from 'react-icons/hi2';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchCoin, fetchLatestBlocks, fetchMasternodeSummary, fetchStats } from '../services/api';
import { useChartAnimation } from '../utils/chartAnimation';
import { formatNumber, formatDifficulty, formatSmallPrice, formatUtcDateTime } from '../utils/formatters';
import { usePageVisibility } from '../hooks/usePageVisibility';
import { useMarketSnapshot } from '../hooks/useMarketSnapshot';
import { computeMasternodeEconomics } from '../utils/masternodeEconomics';
import './PageStyles.css';
import './MiningPage.css';

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'N/A';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
  }
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const chartColor = 'var(--chart-series-1)';

// Chart axis labels in UTC: the time of day for a short window, the day for a longer one.
const AXIS_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const AXIS_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const SHORT_WINDOW_SECONDS = 48 * 3600;

export default function MiningPage() {
  const isPageVisible = usePageVisibility();
  const chartAnimation = useChartAnimation();

  const statsQuery = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
    staleTime: 45_000,
    refetchInterval: isPageVisible ? 90_000 : false,
  });
  const { data: coin } = useQuery({
    queryKey: ['coin'],
    queryFn: fetchCoin,
  });
  const { data: blocks } = useQuery({
    queryKey: ['latest-blocks', 50],
    queryFn: () => fetchLatestBlocks(50),
    staleTime: 45_000,
    refetchInterval: isPageVisible ? 90_000 : false,
  });
  const masternodesQuery = useQuery({
    queryKey: ['masternodes', 'summary', 'rewards-fallback'],
    queryFn: fetchMasternodeSummary,
    staleTime: 45_000,
    refetchInterval: isPageVisible ? 90_000 : false,
  });
  const marketQuery = useMarketSnapshot({
    staleTime: 45_000,
    refetchInterval: isPageVisible ? 90_000 : false,
  });
  const masternodesData = masternodesQuery.isError ? undefined : masternodesQuery.data;
  const stats = statsQuery.data;
  const market = marketQuery.data;
  const loading = statsQuery.isLoading;
  const marketLoading = marketQuery.isLoading;

  // Build chart data from real blocks
  const difficultyHistory = useMemo(
    () => (blocks || []).slice().reverse().map((b) => ({ timestamp: b.time, difficulty: b.difficulty })),
    [blocks]
  );
  const difficultyWindowSeconds = difficultyHistory.length > 1
    ? difficultyHistory[difficultyHistory.length - 1].timestamp - difficultyHistory[0].timestamp
    : 0;
  const formatDifficultyTick = (seconds: number) =>
    (difficultyWindowSeconds < SHORT_WINDOW_SECONDS ? AXIS_TIME : AXIS_DAY).format(new Date(seconds * 1000));

  // ── Masternode income & ROI calculations (memoized) ─────────────
  const {
    totalBlockReward, effectiveStakingReward, mnRewardPerBlock, supply,
    collateral, onlineMn, totalMn, poseBannedMn,
    hasOnlineMn, avgBlockTime,
    roi, paybackDays, avgRewardFreqSec, coinsLockedOnline, coinsLockedOnlinePct,
  } = useMemo(
    () => computeMasternodeEconomics({ stats, coin, summary: masternodesData }),
    [stats, coin, masternodesData]
  );

  const priceUsd = market?.available ? market?.price?.usd ?? null : null;
  const masternodeValueUsd =
    typeof priceUsd === 'number' && Number.isFinite(priceUsd) && collateral > 0
      ? collateral * priceUsd
      : null;

  const ready = !loading && stats != null && coin != null;
  const displayTotalMn = totalMn > 0 ? totalMn : hasOnlineMn ? onlineMn : 0;
  const [calculatorMnCount, setCalculatorMnCount] = useState(1);

  const [calculatorMode, setCalculatorMode] = useState<'existing' | 'new'>('existing');
  const calculatorMaxNodes = calculatorMode === 'existing' ? Math.max(1, Math.min(10, onlineMn)) : 10;
  const selectedMnCount = Math.max(1, Math.min(calculatorMnCount, calculatorMaxNodes));
  const sliderProgress = calculatorMaxNodes <= 1 ? 100 : ((selectedMnCount - 1) / (calculatorMaxNodes - 1)) * 100;
  const sliderStyle = { '--slider-progress': `${sliderProgress}%` } as CSSProperties;
  const projectedNetworkNodes = onlineMn + (calculatorMode === 'new' ? selectedMnCount : 0);
  const calculatorReady = ready && !statsQuery.isError && hasOnlineMn && mnRewardPerBlock > 0;
  const rewardInterval = projectedNetworkNodes * avgBlockTime;
  const monthlyPayments = calculatorReady ? (30 * 86400 / rewardInterval) * selectedMnCount : 0;
  const calculatorDailyIncome = calculatorReady
    ? mnRewardPerBlock * (86400 / avgBlockTime) * selectedMnCount / projectedNetworkNodes : 0;
  const calculatorWeeklyIncome = calculatorDailyIncome * 7;
  const calculatorMonthlyIncome = calculatorDailyIncome * 30;
  const calculatorYearlyIncome = calculatorDailyIncome * 365;
  const calculatorCollateralNeeded = collateral * selectedMnCount;
  const calculatorUsdValue =
    typeof priceUsd === 'number' && Number.isFinite(priceUsd) && calculatorCollateralNeeded > 0
      ? calculatorCollateralNeeded * priceUsd
      : null;

  const calculatorPresets = useMemo(
    () =>
      Array.from(
        new Set([1, 2, 5, 10, calculatorMaxNodes].filter((value) => value <= calculatorMaxNodes))
      ).sort((a, b) => a - b),
    [calculatorMaxNodes]
  );

  const incomeProjectionCards = [
    { key: 'monthly', label: 'Estimated monthly rewards (30 days)', amount: calculatorMonthlyIncome },
    { key: 'daily', label: 'Daily average', amount: calculatorDailyIncome },
    { key: 'weekly', label: 'Weekly average', amount: calculatorWeeklyIncome },
    { key: 'yearly', label: 'Yearly estimate (365 days)', amount: calculatorYearlyIncome },
  ] as const;

  return (
    <div className="fade-in rewards-page">
      <div className="page-header">
        <h1 className="page-title"><HiOutlineCpuChip /> Network Rewards</h1>
        <p className="page-subtitle">Masternode, staking rewards and network performance</p>
      </div>

      {/* ── Top Stats ────────────────────────────────────────────── */}
      <div className="grid-stats rewards-top-stats" style={{ marginBottom: '1.5rem' }}>
        <div className="stat-card rewards-kpi rewards-kpi--mn">
          <div className="stat-label"><HiOutlineServerStack /> Online Masternodes</div>
          <div className="stat-value">
            {loading ? '...' : (hasOnlineMn ? formatNumber(onlineMn) : 'N/A')}
          </div>
          {!loading && totalMn > 0 && (
            <div className="rewards-kpi-meta">
              {formatNumber(totalMn)} total ({formatNumber(poseBannedMn)} PoSe banned)
            </div>
          )}
        </div>
        <div className="stat-card rewards-kpi rewards-kpi--wallets">
          <div className="stat-label"><HiOutlineWallet /> Staking Wallets</div>
          <div className="stat-value">
            {loading ? '...' : (stats?.stakingWallets != null ? formatNumber(stats.stakingWallets) : 'N/A')}
          </div>
        </div>
        <div className="stat-card rewards-kpi rewards-kpi--reward">
          <div className="stat-label"><HiOutlineBanknotes /> Block Reward</div>
          <div className="stat-value">
            {loading
              ? '...'
              : `${formatNumber(totalBlockReward)} DFCN`}
          </div>
        </div>
        <div className="stat-card rewards-kpi rewards-kpi--blocktime">
          <div className="stat-label"><HiOutlineClock /> Avg Block Time</div>
          <div className="stat-value">{loading ? '...' : `${stats?.avgBlockTime || 0}s`}</div>
          <div className="rewards-kpi-meta">7-day average</div>
        </div>
      </div>

      {/* ── Masternode Reward Calculator ───────────────────────────── */}
      <div className="card rewards-income-panel" style={{ marginBottom: '1.5rem' }}>
        <div className="card-header">
          <h2 className="card-title"><HiOutlineCalculator /> Masternode Reward Calculator</h2>
        </div>
        <div className="mn-income-tools">
          <div className="mn-income-summary">
            <div className="mn-income-mode" role="group" aria-label="Calculation mode">
              <button type="button" className={`mn-income-preset ${calculatorMode === 'existing' ? 'active' : ''}`}
                aria-pressed={calculatorMode === 'existing'} onClick={() => setCalculatorMode('existing')}>Existing nodes</button>
              <button type="button" className={`mn-income-preset ${calculatorMode === 'new' ? 'active' : ''}`}
                aria-pressed={calculatorMode === 'new'} onClick={() => setCalculatorMode('new')}>Add new nodes</button>
            </div>
            <div className="mn-income-selected" aria-live="polite">
              <span>Masternodes</span>
              <strong>{formatNumber(selectedMnCount)}</strong>
            </div>
          </div>

          <p className="mn-income-note mn-income-baseline">
            {hasOnlineMn
              ? calculatorMode === 'existing'
                ? `Your selected nodes are already included in the ${formatNumber(onlineMn)} active network nodes.`
                : `Adds ${formatNumber(selectedMnCount)} nodes to ${formatNumber(onlineMn)} active nodes: ${formatNumber(projectedNetworkNodes)} nodes sharing rewards.`
              : 'Active network count unavailable. Reward estimates cannot be calculated.'}
          </p>
          <input
            type="range"
            className="mn-income-slider"
            disabled={!hasOnlineMn}
            min={1}
            max={calculatorMaxNodes}
            step={1}
            value={selectedMnCount}
            onChange={(event) => setCalculatorMnCount(Number.parseInt(event.target.value, 10) || 1)}
            aria-label="Masternode count calculator"
            aria-valuemin={1}
            aria-valuemax={calculatorMaxNodes}
            aria-valuenow={selectedMnCount}
            aria-valuetext={`${selectedMnCount} masternodes`}
            style={sliderStyle}
          />
          <div className="mn-income-slider-scale">
            <span>1 MN</span>
            <span>{formatNumber(calculatorMaxNodes)} MN</span>
          </div>

          <div className="mn-income-presets">
            {calculatorPresets.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`mn-income-preset ${preset === selectedMnCount ? 'active' : ''}`}
                aria-pressed={preset === selectedMnCount}
                disabled={!hasOnlineMn}
                onClick={() => setCalculatorMnCount(preset)}
              >
                {formatNumber(preset)}
              </button>
            ))}
          </div>

          <div className="mn-income-metrics">
            <span>
              Locked collateral: <strong>{ready ? `${formatNumber(calculatorCollateralNeeded)} DFCN` : '...'}</strong>
            </span>
            <span>
              Portfolio value:{' '}
              <strong>
                {marketLoading
                  ? '...'
                  : calculatorUsdValue != null
                    ? `$${calculatorUsdValue >= 1 ? formatNumber(calculatorUsdValue, 2) : formatSmallPrice(calculatorUsdValue)}`
                    : 'N/A'}
              </strong>
            </span>
          </div>
        </div>
        <div className="grid-stats rewards-income-grid">
          {incomeProjectionCards.map(({ key, label, amount }) => {
            const usdVal = calculatorReady && typeof priceUsd === 'number' && Number.isFinite(priceUsd) ? amount * priceUsd : null;
            const dfcnText = calculatorReady ? `${formatNumber(amount, 2)} DFCN` : loading ? '...' : 'N/A';
            const usdText =
              usdVal != null
                ? usdVal >= 1
                  ? `$${formatNumber(usdVal, 2)}`
                  : `$${formatSmallPrice(usdVal)}`
                : null;
            return (
              <div className={`stat-card rewards-income-card rewards-income-card--${key}`} key={label}>
                <div className="stat-label">{label}</div>
                <div className="stat-value">{dfcnText}</div>
                {usdText !== null && (
                  <div className="rewards-income-dfcn">~ {usdText}</div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mn-reward-rhythm" aria-label="Reward rhythm">
          <div><span>Per reward</span><strong>{calculatorReady ? `${formatNumber(mnRewardPerBlock, 2)} DFCN` : 'N/A'}</strong></div>
          <div><span>Average interval per node</span><strong>{calculatorReady ? formatDuration(rewardInterval) : 'N/A'}</strong></div>
          <div><span>Rewards in 30 days (all selected nodes)</span><strong>{calculatorReady ? `~ ${formatNumber(monthlyPayments, 1)}` : 'N/A'}</strong></div>
        </div>
        <p className="mn-income-assumptions">
          Rewards arrive as individual payments, not a continuous daily income. Estimates assume all selected nodes
          are eligible and stay active, with unchanged block rewards and average block time. New-node estimates apply
          after activation; they do not predict the first payment. Actual timing and rewards vary.
          USD values are indicative; hosting costs, fees and taxes are excluded.
        </p>
      </div>

      {/* ── Masternode ROI & Statistics ───────────────────────────── */}
      <div className="grid-2" style={{ marginBottom: '1.5rem' }}>
        <div className="card rewards-detail-card rewards-detail-card--roi">
          <div className="card-header">
            <h2 className="card-title"><HiOutlineChartBarSquare /> Network Baseline: One Masternode</h2>
          </div>
          <div className="detail-grid">
            <div className="detail-row">
              <div className="detail-label">ROI (annual)</div>
              <div className="detail-value">
                {ready
                  ? roi > 0
                    ? <><span className="value-highlight">{roi.toFixed(2)}%</span> /year</>
                    : 'N/A'
                  : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Payback Period</div>
              <div className="detail-value">
                {ready
                  ? paybackDays > 0
                    ? <>{formatNumber(paybackDays)} days</>
                    : 'N/A'
                  : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">AVG Reward Frequency</div>
              <div className="detail-value">
                {ready
                  ? avgRewardFreqSec > 0
                    ? `Every ${formatDuration(avgRewardFreqSec)}`
                    : 'N/A'
                  : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">MN Reward / Block</div>
              <div className="detail-value">
                {ready ? `${formatNumber(mnRewardPerBlock, 2)} DFCN` : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Staking Bonus / Block</div>
              <div className="detail-value">
                {ready ? `${formatNumber(effectiveStakingReward)} DFCN` : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Masternode Value</div>
              <div className="detail-value">
                {marketLoading
                  ? '...'
                  : typeof masternodeValueUsd === 'number'
                    ? `$${masternodeValueUsd >= 1 ? formatNumber(masternodeValueUsd, 2) : formatSmallPrice(masternodeValueUsd)}`
                    : 'N/A'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Price (USD)</div>
              <div className="detail-value">
                {marketLoading
                  ? '...'
                  : typeof priceUsd === 'number'
                    ? `$${formatSmallPrice(priceUsd)}`
                    : 'N/A'}
              </div>
            </div>
          </div>
        </div>

        <div className="card rewards-detail-card rewards-detail-card--economics">
          <div className="card-header">
            <h2 className="card-title"><HiOutlineLockClosed /> Network Economics</h2>
          </div>
          <div className="detail-grid">
            <div className="detail-row">
              <div className="detail-label">Total Supply</div>
              <div className="detail-value">
                {ready ? `${formatNumber(supply)} DFCN` : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Max Supply</div>
              <div className="detail-value">
                {coin
                  ? coin.MAX_SUPPLY == null
                    ? 'Infinite (inflationary, fixed daily emission)'
                    : `${formatNumber(coin.MAX_SUPPLY)} DFCN`
                  : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Required Collateral</div>
              <div className="detail-value">
                {coin ? `${formatNumber(collateral)} DFCN` : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Coins Locked (Online MN)</div>
              <div className="detail-value">
                {ready
                  ? hasOnlineMn
                    ? `${formatNumber(coinsLockedOnline)} DFCN (${coinsLockedOnlinePct.toFixed(1)}%)`
                    : 'N/A'
                  : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Masternodes (Total)</div>
              <div className="detail-value">
                {ready
                  ? displayTotalMn > 0
                    ? formatNumber(displayTotalMn)
                    : 'N/A'
                  : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Masternodes (Online)</div>
              <div className="detail-value">
                {ready
                  ? hasOnlineMn
                    ? formatNumber(onlineMn)
                    : 'N/A'
                  : '...'}
              </div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Masternodes (PoSe Banned)</div>
              <div className="detail-value">
                {ready ? formatNumber(poseBannedMn) : '...'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Charts ───────────────────────────────────────────────── */}
      <div className="card rewards-activity-card">
          <div className="card-header">
            <h2 className="card-title"><HiOutlineArrowTrendingUp /> Difficulty, last {difficultyHistory.length} blocks</h2>
            <span className="text-muted">Times in UTC</span>
          </div>
          {difficultyHistory.length > 1 ? (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={difficultyHistory}>
                <defs>
                  <linearGradient id="diffGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={chartColor} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={formatDifficultyTick}
                  minTickGap={24}
                  stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false}
                />
                <YAxis
                  tickFormatter={(v) => formatDifficulty(v)}
                  stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false} width={65}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '8px' }}
                  labelFormatter={(t) => formatUtcDateTime(Number(t) * 1000)}
                  formatter={(v: number) => [formatDifficulty(v), 'Difficulty']}
                />
                <Area
                  type="monotone"
                  dataKey="difficulty"
                  stroke={chartColor}
                  strokeWidth={2}
                  fill="url(#diffGrad)"
                  {...chartAnimation}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>Syncing data...</div>
          )}
      </div>

    </div>
  );
}
