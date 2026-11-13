import type { CoinConfigView, MasternodeSummaryView, StatsView } from '../types/api';

export interface MasternodeEconomicsInput {
  stats: Partial<Pick<StatsView, 'blockReward' | 'stakingReward' | 'avgBlockTime' | 'supply' | 'masternodes'>> | undefined;
  coin: Pick<CoinConfigView, 'INITIAL_REWARD' | 'MASTERNODE_COLLATERAL' | 'BLOCK_TIME_SECONDS'> | undefined;
  summary: Partial<Pick<MasternodeSummaryView, 'total' | 'enabled' | 'poseBanned'>> | undefined;
}

export interface MasternodeEconomics {
  totalBlockReward: number;
  effectiveStakingReward: number;
  mnRewardPerBlock: number;
  supply: number;
  collateral: number;
  onlineMn: number;
  totalMn: number;
  poseBannedMn: number;
  hasOnlineMn: boolean;
  avgBlockTime: number;
  /** Yearly masternode income as a percentage of the collateral; 0 when it cannot be computed. */
  roi: number;
  paybackDays: number;
  avgRewardFreqSec: number;
  coinsLockedOnline: number;
  /** Collateral of the online masternodes as a percentage of the circulating supply; 0 when unknown. */
  coinsLockedOnlinePct: number;
}

/**
 * Masternode income figures shared by the Rewards page and the dashboard. The block reward is split
 * into the stake reward and the masternode payment; every online masternode gets an equal share of
 * the daily masternode pool. A missing input makes the dependent figures 0, never a guess.
 */
export function computeMasternodeEconomics({ stats, coin, summary }: MasternodeEconomicsInput): MasternodeEconomics {
  const rawBlockReward = stats?.blockReward ?? 0;
  const configuredBaseReward = coin?.INITIAL_REWARD ?? 0;
  const reportedStakingReward = stats?.stakingReward ?? 0;
  const effectiveStakingReward =
    reportedStakingReward > 0
      ? reportedStakingReward
      : configuredBaseReward > 0 && rawBlockReward > configuredBaseReward
        ? rawBlockReward - configuredBaseReward
        : 0;
  const blockRewardBase =
    rawBlockReward > 0 ? Math.max(rawBlockReward - effectiveStakingReward, 0) : configuredBaseReward;
  const collateral = coin?.MASTERNODE_COLLATERAL ?? 0;
  const totalMn = summary?.total ?? 0;
  const onlineMn = summary?.enabled ?? stats?.masternodes ?? 0;
  const poseBannedMn = summary?.poseBanned ?? 0;
  const avgBlockTime = Math.max(1, stats?.avgBlockTime || coin?.BLOCK_TIME_SECONDS || 150);
  const blocksPerDay = 86400 / avgBlockTime;
  const mnRewardPerBlock = blockRewardBase;
  const totalBlockReward = rawBlockReward > 0 ? rawBlockReward : blockRewardBase + effectiveStakingReward;

  const dailyMnPool = mnRewardPerBlock * blocksPerDay;
  const hasOnlineMn = onlineMn > 0;
  const dailyIncome = hasOnlineMn ? dailyMnPool / onlineMn : 0;
  const yearlyIncome = dailyIncome * 365;

  const roi = collateral > 0 && yearlyIncome > 0 ? (yearlyIncome / collateral) * 100 : 0;
  const paybackDays = dailyIncome > 0 && collateral > 0 ? Math.round(collateral / dailyIncome) : 0;
  const avgRewardFreqSec = onlineMn > 0 ? onlineMn * avgBlockTime : 0;

  const coinsLockedOnline = onlineMn * collateral;
  const supply = stats?.supply?.circulating ?? 0;
  const coinsLockedOnlinePct = supply > 0 && coinsLockedOnline > 0 ? (coinsLockedOnline / supply) * 100 : 0;

  return {
    totalBlockReward,
    effectiveStakingReward,
    mnRewardPerBlock,
    supply,
    collateral,
    onlineMn,
    totalMn,
    poseBannedMn,
    hasOnlineMn,
    avgBlockTime,
    roi,
    paybackDays,
    avgRewardFreqSec,
    coinsLockedOnline,
    coinsLockedOnlinePct,
  };
}
