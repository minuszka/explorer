import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  HiOutlineArrowRight,
  HiOutlineArrowTrendingUp,
  HiOutlineBanknotes,
  HiOutlineChevronDown,
  HiOutlineChevronUp,
  HiOutlineCube,
} from 'react-icons/hi2';
import { fetchBlockTxs, fetchCoin, fetchDashboardOverview, fetchMasternodeSummary } from '../services/api';
import {
  formatAge,
  formatBytes,
  formatCoin,
  formatNumber,
  formatSmallPrice,
  truncateHash,
} from '../utils/formatters';
import { useMarketSnapshot } from '../hooks/useMarketSnapshot';
import { usePageVisibility } from '../hooks/usePageVisibility';
import type { DashboardBlockView, DashboardTxView, TxListItemView } from '../types/api';
import './DashboardPage.css';
import { txPath } from '../utils/routes';
import { computeMasternodeEconomics } from '../utils/masternodeEconomics';
const TX_PREVIEW_MAX = 12;
const REWARD_TOLERANCE = 0.0000001;
const PROTOCOL_TX_TOLERANCE = 0.0000001;
const EMPTY_BLOCKS: DashboardBlockView[] = [];
const EMPTY_TXS: DashboardTxView[] = [];

type RewardRole = 'mn' | 'stake' | 'transfer';

interface PreviewTxBreakdown {
  role: RewardRole;
  totalInput: number;
  totalOutput: number;
  rewardDelta: number;
}

function getPreviewTxBreakdown(tx: TxListItemView, stakeRewardPerBlock: number | null): PreviewTxBreakdown {
  const totalInput = typeof tx.totalValueIn === 'number' ? tx.totalValueIn : 0;
  const totalOutput = typeof tx.totalValueOut === 'number' ? tx.totalValueOut : 0;
  const rewardDelta = Math.max(totalOutput - totalInput, 0);

  if (rewardDelta <= REWARD_TOLERANCE) {
    return { role: 'transfer', totalInput, totalOutput, rewardDelta: 0 };
  }

  if (stakeRewardPerBlock != null && Math.abs(rewardDelta - stakeRewardPerBlock) <= REWARD_TOLERANCE) {
    return { role: 'stake', totalInput, totalOutput, rewardDelta };
  }

  if (tx.isCoinbase) {
    return { role: 'mn', totalInput, totalOutput, rewardDelta };
  }

  return { role: 'mn', totalInput, totalOutput, rewardDelta };
}

function rewardRoleLabel(role: RewardRole): string {
  if (role === 'stake') return 'Stake Reward';
  if (role === 'mn') return 'MN Reward';
  return 'Transfer';
}

/** The server buckets flow by UTC hour, so the hour is shown in UTC too, not in the browser's time zone. */
function formatFlowHour(hourIso: string): string {
  const d = new Date(hourIso);
  if (Number.isNaN(d.getTime())) return hourIso.slice(11, 16);
  return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

function formatMarketAge(ageSeconds: number | null | undefined): string | null {
  if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds) || ageSeconds < 0) return null;
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const COMPACT_NUMBER = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function formatCompactCoin(value: number): string {
  return COMPACT_NUMBER.format(value);
}

function formatBlockTime(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

/** Same precision as the Rewards page: the ROI with two decimals, the locked share with one. */
function formatPercent(value: number, digits: number): string {
  return `${value.toFixed(digits)}%`;
}

interface HeroMetricProps {
  label: string;
  value: string;
  note?: string;
  title?: string;
}

function HeroMetric({ label, value, note, title }: HeroMetricProps) {
  return (
    <div className="dashboard-metric">
      <dt className="dashboard-metric-label">{label}</dt>
      <dd className="dashboard-metric-value" title={title}>{value}</dd>
      {note && <dd className="dashboard-metric-note">{note}</dd>}
    </div>
  );
}

interface LatestBlockRowProps {
  block: DashboardBlockView;
  stakeRewardPerBlock: number | null;
  isExpanded: boolean;
  onToggle: (height: number) => void;
  priceUsd: number | null;
}

function LatestBlockRow({ block, stakeRewardPerBlock, isExpanded, onToggle, priceUsd }: LatestBlockRowProps) {
  const previewLimit = Math.min(Math.max(block.nTx, 2), TX_PREVIEW_MAX);
  const { data: txPreviewResponse, isLoading: txPreviewLoading } = useQuery({
    queryKey: ['block-preview-txs', block.height, previewLimit],
    queryFn: () => fetchBlockTxs(String(block.height), 1, previewLimit),
    enabled: isExpanded,
    staleTime: 30_000,
  });

  const txPreview = txPreviewResponse?.data || [];
  const totalReward = typeof block.reward === 'number' ? block.reward : 0;
  const splitStake =
    stakeRewardPerBlock != null && totalReward >= stakeRewardPerBlock ? stakeRewardPerBlock : 0;
  const splitMasternode = Math.max(totalReward - splitStake, 0);
  const producerLabel = block.minedBy ? truncateHash(block.minedBy, 8) : 'Unknown';

  return (
    <article className={`latest-item-shell ${isExpanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className="latest-item-trigger"
        onClick={() => onToggle(block.height)}
        aria-expanded={isExpanded}
        aria-controls={`latest-block-preview-${block.height}`}
      >
        <div className="latest-item-icon block-icon">
          <HiOutlineCube />
        </div>
        <div className="latest-item-info">
          <div className="latest-item-primary">
            <span className="latest-height">#{formatNumber(block.height)}</span>
            <span className="latest-txcount">{block.nTx} txs</span>
            {block.confirmations > 0 && <span className="latest-confirmations">{block.confirmations} conf</span>}
          </div>
          <div className="latest-item-secondary">
            <span className="mono">{truncateHash(block.hash, 10)}</span>
            <span className="latest-time">{formatAge(block.time)}</span>
            <span className="latest-producer">Producer {producerLabel}</span>
          </div>
        </div>
        <div className="latest-item-value">
          {splitStake > 0 ? (
            <>
              <span className="reward-chip reward-chip-mn">MN {formatCoin(splitMasternode)} DFCN</span>
              <span className="reward-chip reward-chip-stake">Stake {formatCoin(splitStake)} DFCN</span>
              <span className="latest-size">
                Total {formatCoin(totalReward)} DFCN
                {priceUsd != null && totalReward > 0 && ` ~ $${formatSmallPrice(totalReward * priceUsd, 4)}`}
              </span>
            </>
          ) : (
            <>
              <span className="latest-reward">{formatCoin(totalReward)} DFCN</span>
              <span className="latest-size">
                {priceUsd != null && totalReward > 0
                  ? `~ $${formatSmallPrice(totalReward * priceUsd, 4)}`
                  : formatBytes(block.size)}
              </span>
            </>
          )}
        </div>
        <span className="latest-expand-icon" aria-hidden="true">
          {isExpanded ? <HiOutlineChevronUp /> : <HiOutlineChevronDown />}
        </span>
      </button>

      {isExpanded && (
        <div id={`latest-block-preview-${block.height}`} className="latest-item-expand">
          <div className="latest-item-expand-header">
            <div className="latest-inline-title-wrap">
              <span className="latest-inline-title">Block transactions</span>
              <span className="latest-inline-help">Reward = Output - Input</span>
            </div>
            <Link to={`/block/${encodeURIComponent(String(block.height))}`} className="latest-inline-link">
              Open block <HiOutlineArrowRight />
            </Link>
          </div>

          {txPreviewLoading ? (
            <div className="latest-inline-loading">Loading {block.nTx} transaction(s)...</div>
          ) : txPreview.length === 0 ? (
            <div className="latest-inline-loading">No transactions found for this block.</div>
          ) : (
            <div className="latest-inline-list">
              {txPreview.map((tx) => {
                const { role: txRole, totalInput, totalOutput, rewardDelta } = getPreviewTxBreakdown(
                  tx,
                  stakeRewardPerBlock
                );

                return (
                  <div key={tx.txid} className="latest-inline-item">
                    <div className="latest-inline-main">
                      <Link to={txPath(tx.txid)} className="mono hash">
                        {truncateHash(tx.txid, 14)}
                      </Link>
                      {tx.isDonation && <span className="badge donate">Donate</span>}
                      <span className={`badge latest-inline-badge latest-inline-badge-${txRole}`}>
                        {rewardRoleLabel(txRole)}
                      </span>
                    </div>
                    <div className="latest-inline-meta">
                      {tx.isDonation && (tx.donationAmount || 0) > 0 ? (
                        <>
                          <span className="mono latest-inline-donate">
                            Donated {formatCoin(tx.donationAmount || 0)} DFCN
                          </span>
                          <span className="mono latest-inline-io">
                            In {formatCoin(totalInput)}
                            {' -> '}
                            Out {formatCoin(totalOutput)} DFCN
                          </span>
                        </>
                      ) : rewardDelta > 0 ? (
                        <>
                          <span className="mono latest-inline-reward">Reward +{formatCoin(rewardDelta)} DFCN</span>
                          <span className="mono latest-inline-io">
                            In {formatCoin(totalInput)}
                            {' -> '}
                            Out {formatCoin(totalOutput)} DFCN
                          </span>
                        </>
                      ) : (
                        <span className="mono latest-inline-io">Out {formatCoin(totalOutput)} DFCN</span>
                      )}
                      <span>{formatAge(tx.blocktime || block.time)}</span>
                      <span>{formatBytes(tx.size || 0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {block.nTx > txPreview.length && (
            <div className="latest-inline-more">
              Showing first {txPreview.length} of {block.nTx} txs.
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function DashboardPage() {
  const [expandedBlockHeight, setExpandedBlockHeight] = useState<number | null>(null);
  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: fetchDashboardOverview,
  });
  // The same inputs as the Rewards page, under the same query keys and refresh, so both pages show one ROI.
  // The overview refreshes with new blocks; the masternode list does not, so it polls like on the Rewards page.
  const isPageVisible = usePageVisibility();
  const coinQuery = useQuery({ queryKey: ['coin'], queryFn: fetchCoin });
  const masternodeSummaryQuery = useQuery({
    queryKey: ['masternodes', 'summary', 'rewards-fallback'],
    queryFn: fetchMasternodeSummary,
    staleTime: 45_000,
    refetchInterval: isPageVisible ? 90_000 : false,
  });
  const { data: market, isLoading: marketLoading } = useMarketSnapshot({
    staleTime: 45_000,
    refetchInterval: 60_000,
  });
  const priceUsd = typeof market?.price?.usd === 'number' ? market.price.usd : null;
  const priceChange24h = typeof market?.price?.change24h === 'number' ? market.price.change24h : null;
  const marketAge = formatMarketAge(market?.ageSeconds);
  const stats = overview?.stats;
  const blocks = overview?.blocks ?? EMPTY_BLOCKS;
  const txs = overview?.txs ?? EMPTY_TXS;

  const totalValueTransferred24h =
    typeof stats?.totalValueTransferred24h === 'number' ? stats.totalValueTransferred24h : null;
  const txCount24h = typeof stats?.txCount24h === 'number' ? stats.txCount24h : null;
  const flow24h = stats?.flow24h ?? [];
  const flow24hBlocks = flow24h.reduce((sum, point) => sum + point.blocks, 0);
  const avgTxPerBlock24h = flow24hBlocks > 0 && txCount24h != null ? txCount24h / flow24hBlocks : null;
  const flowBars = useMemo(() => {
    const peakBlocks = Math.max(1, ...flow24h.map((point) => point.blocks));
    const peakTxs = Math.max(1, ...flow24h.map((point) => point.txs));
    return flow24h.map((point) => {
      const blocksPct = point.blocks > 0 ? Math.max(8, Math.round((point.blocks / peakBlocks) * 100)) : 0;
      const txsPct = point.txs > 0 ? Math.max(6, Math.round((point.txs / peakTxs) * 100)) : 0;
      return {
        ...point,
        blocksPct,
        txsPct,
      };
    });
  }, [flow24h]);
  const stakeRewardPerBlock =
    typeof stats?.stakingReward === 'number' && stats.stakingReward > 0 ? stats.stakingReward : null;

  const masternodeSummary = masternodeSummaryQuery.isError ? undefined : masternodeSummaryQuery.data;
  const economics = useMemo(
    () => computeMasternodeEconomics({ stats, coin: coinQuery.data, summary: masternodeSummary }),
    [stats, coinQuery.data, masternodeSummary]
  );
  // A figure is "..." while its inputs load and "N/A" when they did not arrive or cannot give one.
  const statsValue = (render: () => string | null) => {
    if (overviewLoading) return '...';
    if (!stats) return 'N/A';
    return render() ?? 'N/A';
  };
  const circulating = typeof stats?.supply?.circulating === 'number' && stats.supply.circulating > 0
    ? stats.supply.circulating
    : null;
  // Wait for the masternode list too, so the figure does not first show the fallback count and then jump.
  const economicsLoading = coinQuery.isLoading || masternodeSummaryQuery.isLoading;
  const roiValue = economicsLoading
    ? '...'
    : statsValue(() => (coinQuery.data && economics.roi > 0 ? formatPercent(economics.roi, 2) : null));
  const lockedValue = economicsLoading
    ? '...'
    : statsValue(() => (coinQuery.data && economics.coinsLockedOnlinePct > 0 ? formatPercent(economics.coinsLockedOnlinePct, 1) : null));

  return (
    <div className="dashboard fade-in">
      <section className="dashboard-hero" aria-label="Dashboard overview">
        <dl className="dashboard-metrics">
          <div className="dashboard-metric" aria-label="DFCN market snapshot">
            <dt className="dashboard-metric-label">DFCN / USD</dt>
            <dd className="dashboard-market-main">
              <strong className="dashboard-metric-value">
                {marketLoading ? '...' : priceUsd != null ? `$${formatSmallPrice(priceUsd, 4)}` : 'N/A'}
              </strong>
              {priceChange24h != null && !marketLoading && (
                <span className={`dashboard-market-change ${priceChange24h >= 0 ? 'positive' : 'negative'}`}>
                  {priceChange24h >= 0 ? '+' : ''}
                  {priceChange24h.toFixed(2)}%
                </span>
              )}
            </dd>
            {market?.freshness === 'stale' && (
              <dd className="dashboard-market-freshness">
                <span role="status">Market data delayed{marketAge ? ` · ${marketAge} ago` : ''}</span>
              </dd>
            )}
          </div>
          <HeroMetric
            label="Circulating supply"
            value={statsValue(() => (circulating != null ? `${formatCompactCoin(circulating)} DFCN` : null))}
            title={circulating != null ? `${formatNumber(circulating)} DFCN` : undefined}
          />
          <HeroMetric label="Masternode ROI" value={roiValue} note="per year at the current reward" />
          <HeroMetric
            label="Avg block time"
            value={statsValue(() => (typeof stats?.avgBlockTime === 'number' && stats.avgBlockTime > 0 ? formatBlockTime(stats.avgBlockTime) : null))}
            note="7-day average"
            title={typeof stats?.avgBlockTime === 'number' && stats.avgBlockTime > 0 ? `${stats.avgBlockTime} seconds` : undefined}
          />
          <HeroMetric label="Collateral locked" value={lockedValue} note="of the circulating supply" />
          <HeroMetric
            label="Transactions (24h)"
            value={statsValue(() => (txCount24h != null ? formatNumber(txCount24h) : null))}
          />
        </dl>
      </section>

      <section className="grid-2 dashboard-latest">
        <div className="card latest-card">
          <div className="card-header dashboard-section-header">
            <h2 className="card-title">
              <HiOutlineCube /> Latest Blocks
            </h2>
            <Link to="/blocks" className="btn btn-sm btn-secondary">
              View all <HiOutlineArrowRight />
            </Link>
          </div>
          <div className="latest-list">
            {overviewLoading ? (
              <div className="latest-placeholder">Loading blocks...</div>
            ) : blocks.length === 0 ? (
              <div className="latest-placeholder">No blocks available yet.</div>
            ) : (
              blocks.map((block) => (
                <LatestBlockRow
                  key={block.height}
                  block={block}
                  stakeRewardPerBlock={stakeRewardPerBlock}
                  isExpanded={expandedBlockHeight === block.height}
                  onToggle={(height) =>
                    setExpandedBlockHeight((currentHeight) => (currentHeight === height ? null : height))
                  }
                  priceUsd={priceUsd}
                />
              ))
            )}
          </div>
        </div>

        <div className="card latest-card">
          <div className="card-header dashboard-section-header">
            <h2 className="card-title">
              <HiOutlineBanknotes /> Latest Transactions
            </h2>
            <Link to="/txs" className="btn btn-sm btn-secondary">
              View all <HiOutlineArrowRight />
            </Link>
          </div>
          <div className="latest-list">
            {overviewLoading ? (
              <div className="latest-placeholder">Loading transactions...</div>
            ) : txs.length === 0 ? (
              <div className="latest-placeholder">No transactions available yet.</div>
            ) : (
              txs.map((tx) => (
                <Link to={txPath(tx.txid)} key={tx.txid} className="latest-item">
                  <div className="latest-item-icon tx-icon">
                    <HiOutlineBanknotes />
                  </div>
                  <div className="latest-item-info">
                    <div className="latest-item-primary">
                      <span className="mono hash">{truncateHash(tx.txid, 10)}</span>
                      {tx.isDonation && <span className="badge donate">Donate</span>}
                    </div>
                    <div className="latest-item-secondary">
                      <span>Block #{formatNumber(tx.blockheight)}</span>
                      <span className="latest-time">{formatAge(tx.blocktime)}</span>
                    </div>
                  </div>
                  <div className="latest-item-value">
                    {tx.isDonation && (tx.donationAmount || 0) > 0 ? (
                      <>
                        <span className="latest-amount latest-donate-amount">
                          Donated {formatCoin(tx.donationAmount || 0)} DFCN
                        </span>
                        <span className="latest-size">Tx total out {formatCoin(tx.totalValueOut)} DFCN</span>
                      </>
                    ) : !tx.isCoinbase && Math.abs(tx.totalValueOut || 0) <= PROTOCOL_TX_TOLERANCE ? (
                      <>
                        <span className="badge">Protocol TX</span>
                        <span className="latest-size">No coin transfer</span>
                      </>
                    ) : (
                      <>
                        <span className="latest-amount">{formatCoin(tx.totalValueOut)} DFCN</span>
                        <span className="latest-size">
                          {tx.isCoinbase ? 'Block Reward' : priceUsd != null && (tx.totalValueOut || 0) > 0
                            ? `~ $${formatSmallPrice((tx.totalValueOut || 0) * priceUsd, 4)}`
                            : null}
                        </span>
                      </>
                    )}
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="card flow-card">
        <div className="card-header dashboard-section-header">
          <h2 className="card-title">
            <HiOutlineArrowTrendingUp /> Live Flow (24h)
          </h2>
          <span className="text-muted">Hourly blocks and tx volume</span>
        </div>

        <div className="flow-kpis">
          <div className="flow-kpi">
            <span>Blocks (24h)</span>
            <strong>{overviewLoading ? '...' : formatNumber(flow24hBlocks)}</strong>
          </div>
          <div className="flow-kpi">
            <span>Avg tx/block (24h)</span>
            <strong>
              {overviewLoading
                ? '...'
                : avgTxPerBlock24h != null
                  ? avgTxPerBlock24h.toFixed(2)
                  : 'n/a'}
            </strong>
          </div>
          <div className="flow-kpi">
            <span>Transferred (24h)</span>
            <strong>
              {overviewLoading
                ? '...'
                : totalValueTransferred24h != null
                  ? `~ ${formatCompactCoin(totalValueTransferred24h)} DFCN`
                  : 'n/a'}
            </strong>
          </div>
        </div>

        {flowBars.length > 0 ? (
          <>
            <div className="flow-bars" aria-label="Hourly flow chart">
              {flowBars.map((point) => (
                <div
                  key={point.hour}
                  className="flow-bar-item"
                  title={`${formatFlowHour(point.hour)} UTC | ${point.blocks} blocks | ${point.txs} txs`}
                >
                  <span className="flow-bar flow-bar-blocks" style={{ height: `${point.blocksPct}%` }} />
                  <span className="flow-bar flow-bar-txs" style={{ height: `${point.txsPct}%` }} />
                </div>
              ))}
            </div>
            <div className="flow-legend">
              <span><i className="flow-dot flow-dot-blocks" /> Blocks/hour</span>
              <span><i className="flow-dot flow-dot-txs" /> Txs/hour</span>
              <span>
                {formatFlowHour(flowBars[0].hour)} - {formatFlowHour(flowBars[flowBars.length - 1].hour)} UTC
              </span>
            </div>
          </>
        ) : (
          <div className="latest-placeholder">Waiting for 24h flow data...</div>
        )}
      </section>
    </div>
  );
}
