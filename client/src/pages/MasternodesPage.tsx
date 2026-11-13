import { useMemo, useState } from 'react';
import {
  HiOutlineGlobeAlt,
  HiOutlineMapPin,
  HiOutlineServerStack,
  HiOutlineTag,
} from 'react-icons/hi2';
import { useQuery } from '@tanstack/react-query';
import {
  fetchActiveMasternodeVersions,
  fetchMasternodeDistribution,
  fetchMasternodeSummary,
  fetchMasternodes,
} from '../services/api';
import { formatNumber } from '../utils/formatters';
import { CountryRanking, ProviderRanking, type CountryRank, type ProviderRank } from './masternodes/DistributionLists';
import MasternodeTable from './masternodes/MasternodeTable';
import { buildRows } from './masternodes/masternodeRows';
import './PageStyles.css';
import './MasternodesPage.css';

type MnFilter =
  | { type: 'country'; value: string; label: string }
  | { type: 'provider'; value: string; label: string }
  | null;

const OTHERS_KEY = '__others';

function isActiveMasternodeStatus(status: string | null | undefined): boolean {
  const normalized = String(status || '').trim().toUpperCase();
  return normalized === 'ENABLED' || normalized === 'POSE_PENALTY';
}

export default function MasternodesPage() {
  const [activeFilter, setActiveFilter] = useState<MnFilter>(null);
  const summaryQuery = useQuery({
    queryKey: ['masternodes', 'summary'],
    queryFn: fetchMasternodeSummary,
    staleTime: 60_000,
  });
  const distributionQuery = useQuery({
    queryKey: ['masternodes', 'distribution'],
    queryFn: fetchMasternodeDistribution,
    staleTime: 60_000,
  });
  // The full snapshot: every node with its proTxHash and payout address (the paged list has neither).
  const nodesQuery = useQuery({
    queryKey: ['masternodes', 'snapshot'],
    queryFn: fetchMasternodes,
    staleTime: 60_000,
  });
  // Last-known wallet versions, matched to the list by registration (proTxHash), never by IP.
  const versionsQuery = useQuery({
    queryKey: ['masternodes', 'active-versions'],
    queryFn: fetchActiveMasternodeVersions,
    staleTime: 60_000,
  });

  const summary = summaryQuery.data;
  const countries = distributionQuery.data?.countries || [];
  const providers = distributionQuery.data?.providers || [];
  const nodes = nodesQuery.data?.nodes || [];

  const loading = summaryQuery.isLoading || distributionQuery.isLoading;
  const nodesLoading = nodesQuery.isLoading;
  const error =
    summaryQuery.error != null || distributionQuery.error != null || nodesQuery.error != null
      ? (((summaryQuery.error || distributionQuery.error || nodesQuery.error) as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ||
          ((summaryQuery.error || distributionQuery.error || nodesQuery.error) as Error)?.message ||
          'Failed to load masternodes')
      : null;

  const topCountries = useMemo(() => countries.slice(0, 8), [countries]);

  // The eight largest countries, then everything else as one "Others" row.
  const countryRanks: CountryRank[] = useMemo(() => {
    const rows: CountryRank[] = topCountries.map((country) => ({
      key: country.countryCode,
      name: country.countryName,
      count: country.count,
    }));
    const restCount = countries.slice(8).reduce((sum, item) => sum + item.count, 0);
    if (restCount > 0) rows.push({ key: OTHERS_KEY, name: 'Others', count: restCount });
    return rows;
  }, [countries, topCountries]);

  const providerRanks: ProviderRank[] = useMemo(
    () =>
      providers.slice(0, 10).map((provider) => ({
        provider: provider.provider,
        count: provider.count,
        tagged: provider.tagged ?? 0,
        auto: provider.auto ?? Math.max(0, provider.count - (provider.tagged ?? 0)),
      })),
    [providers],
  );

  const topCountryCodes = useMemo(() => new Set(topCountries.map((country) => country.countryCode)), [topCountries]);

  const activeNodes = useMemo(
    () => nodes.filter((node) => isActiveMasternodeStatus(node.status)),
    [nodes],
  );

  // Every active registration, before the country or provider filter: the table uses it to tell a
  // starred node hidden by that filter from one that is no longer active.
  const activeRegistrations = useMemo(
    () => new Set(activeNodes.flatMap((node) => (node.proTxHash ? [node.proTxHash.toLowerCase()] : []))),
    [activeNodes],
  );

  const visibleNodes = useMemo(() => {
    if (!activeFilter) return activeNodes;
    if (activeFilter.type === 'country') {
      if (activeFilter.value === OTHERS_KEY) {
        return activeNodes.filter((node) => !topCountryCodes.has(node.countryCode));
      }
      return activeNodes.filter((node) => node.countryCode === activeFilter.value);
    }
    return activeNodes.filter((node) => node.provider === activeFilter.value);
  }, [activeFilter, activeNodes, topCountryCodes]);

  const tableRows = useMemo(
    () => buildRows(visibleNodes, versionsQuery.data?.nodes ?? null),
    [visibleNodes, versionsQuery.data],
  );
  // A failed background refresh keeps showing the last good snapshot; only a first load fails here.
  const nodesError =
    nodesQuery.error != null && !nodesQuery.data
      ? ((nodesQuery.error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ||
          (nodesQuery.error as Error)?.message ||
          'Failed to load masternodes')
      : null;

  const handleCountryFilter = (entry: CountryRank) => {
    setActiveFilter((current) =>
      current?.type === 'country' && current.value === entry.key
        ? null
        : { type: 'country', value: entry.key, label: entry.name },
    );
  };

  const handleProviderFilter = (entry: ProviderRank) => {
    setActiveFilter((current) =>
      current?.type === 'provider' && current.value === entry.provider
        ? null
        : { type: 'provider', value: entry.provider, label: entry.provider },
    );
  };

  const taggedCount = summary?.tagged ?? 0;
  const totalNodes =
    distributionQuery.data?.total ?? summary?.enabled ?? countries.reduce((sum, country) => sum + country.count, 0);
  const enabledNodesCount = summary?.enabled ?? 0;
  const posePenaltyNodesCount = summary?.posePenalty ?? 0;
  const onlineShare = summary?.enabledPct ?? (summary?.total ? (enabledNodesCount / summary.total) * 100 : 0);
  const topCountry = summary?.topCountry ?? countries[0] ?? null;
  const topProvider = summary?.topProvider ?? providers[0] ?? null;
  const taggedCoveragePct = summary?.taggedCoveragePct ?? 0;

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">
          <HiOutlineServerStack /> Masternodes
        </h1>
        <p className="page-subtitle">Live masternode endpoints with country and hosting provider distribution</p>
        <div className="mn-header-pills">
          <span className="mn-header-pill">Live RPC snapshot</span>
        </div>
      </div>

      <div className="card mn-kpi-shell" style={{ marginBottom: '1.5rem' }}>
        <div className="mn-kpi-grid">
          <div className="mn-kpi-card mn-kpi-card-enabled">
            <div className="mn-kpi-label">
              <HiOutlineMapPin /> Active MN
            </div>
            <div className="mn-kpi-value">{loading ? '...' : formatNumber(enabledNodesCount)}</div>
            <div className="mn-kpi-sub">{loading ? 'Calculating...' : `${onlineShare.toFixed(1)}% of total`}</div>
          </div>

          <div className="mn-kpi-card mn-kpi-card-banned">
            <div className="mn-kpi-label">
              <HiOutlineTag /> PoSe Penalty
            </div>
            <div className="mn-kpi-value">{loading ? '...' : formatNumber(posePenaltyNodesCount)}</div>
            <div className="mn-kpi-sub">Currently receiving penalty points</div>
          </div>

          <div className="mn-kpi-card mn-kpi-card-countries">
            <div className="mn-kpi-label">
              <HiOutlineGlobeAlt /> Countries
            </div>
            <div className="mn-kpi-value">{loading ? '...' : formatNumber(countries.length)}</div>
            <div className="mn-kpi-sub">
              {loading ? 'Loading distribution...' : topCountry ? `Top: ${topCountry.countryName} (${formatNumber(topCountry.count)})` : 'No country data'}
            </div>
          </div>

          <div className="mn-kpi-card mn-kpi-card-tagged">
            <div className="mn-kpi-label">
              <HiOutlineTag /> Tagged Coverage
            </div>
            <div className="mn-kpi-value">{loading ? '...' : `${taggedCoveragePct.toFixed(1)}%`}</div>
            <div className="mn-kpi-sub">
              {loading
                ? 'Loading attribution...'
                : `${formatNumber(taggedCount)} tagged - ${topProvider ? topProvider.provider : 'no top provider'}`}
            </div>
          </div>
        </div>
        <div className="mn-kpi-meta-row mn-kpi-meta-row-compact">
          <span>{loading ? 'Loading region profile...' : `Most common region: ${topCountry ? topCountry.countryName : 'N/A'}`}</span>
          <span>{loading ? 'Loading provider profile...' : `Top provider: ${topProvider ? `${topProvider.provider} (${formatNumber(topProvider.count)})` : 'N/A'}`}</span>
        </div>
      </div>

      {error ? (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <p className="text-muted">{error}</p>
        </div>
      ) : null}

      <div className="grid-2 mn-chart-grid" style={{ marginBottom: '1.5rem' }}>
        <div className="card mn-panel-card">
          <div className="card-header">
            <h2 className="card-title">Masternodes by Country</h2>
            <span className="mn-panel-metric">{loading ? '...' : formatNumber(totalNodes)} nodes</span>
          </div>
          <p className="mn-panel-subtitle">Active nodes per country in the current snapshot; press a row to filter the table.</p>

          {loading ? (
            <div className="placeholder-content" style={{ padding: '2.5rem' }}>
              <p className="text-muted">Loading country distribution...</p>
            </div>
          ) : countryRanks.length === 0 ? (
            <div className="placeholder-content" style={{ padding: '2.5rem' }}>
              <p className="text-muted">No country distribution available</p>
            </div>
          ) : (
            <CountryRanking
              rows={countryRanks}
              total={totalNodes}
              activeKey={activeFilter?.type === 'country' ? activeFilter.value : null}
              onToggle={handleCountryFilter}
            />
          )}
        </div>

        <div className="card mn-panel-card">
          <div className="card-header">
            <h2 className="card-title">Hosting Providers</h2>
            <span className="mn-panel-metric">{loading ? '...' : formatNumber(providerRanks.length)} largest providers</span>
          </div>
          <p className="mn-panel-subtitle">The largest providers, up to ten; each bar splits auto-detected nodes from nodes in tagged address ranges.</p>
          {loading ? (
            <div className="placeholder-content" style={{ padding: '2.5rem' }}>
              <p className="text-muted">Resolving providers...</p>
            </div>
          ) : providerRanks.length === 0 ? (
            <div className="placeholder-content" style={{ padding: '2.5rem' }}>
              <p className="text-muted">No provider data available</p>
            </div>
          ) : (
            <ProviderRanking
              providers={providerRanks}
              activeProvider={activeFilter?.type === 'provider' ? activeFilter.value : null}
              onToggle={handleProviderFilter}
            />
          )}
        </div>
      </div>

      <MasternodeTable
        rows={tableRows}
        loading={nodesLoading}
        error={nodesError}
        versionsLoading={versionsQuery.isPending}
        versionsUnavailable={versionsQuery.isError && !versionsQuery.data}
        activeRegistrations={activeRegistrations}
        pageFilter={
          activeFilter && (
            <>
              <span className="badge badge-accent">
                {activeFilter.type === 'country' ? 'Country' : 'Provider'}: {activeFilter.label}
              </span>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => setActiveFilter(null)}>
                Show all
              </button>
            </>
          )
        }
      />
    </div>
  );
}

