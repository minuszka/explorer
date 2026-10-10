import axios from 'axios';
import type { OperatorDiagnosisData } from '@defcon/shared/dist/contracts';
import { banAttributionApiResponseSchema, poseObservedEventsApiResponseSchema, dnsSeederNodesApiResponseSchema } from '@defcon/shared';
import type { BanAttributionQuery, BanAttributionProof } from '@defcon/shared/dist/contracts';
import type {
  ActiveMasternodeVersionsView,
  AddressBalanceView,
  AddressGraphView,
  ApiEnvelope,
  BlockView,
  CoinConfigView,
  MarketHistoryView,
  MarketSnapshotView,
  MigrationTransparencyView,
  MasternodeDistributionView,
  MasternodesView,
  MasternodeNodesView,
  MasternodeSummaryView,
  MasternodeHealthView,
  MasternodeEventsView,
  BanWaveAnalysisView,
  NodeInventoryView,
  NetworkNoiseSummaryView,
  ProviderTagBulkSubmissionInput,
  ProviderTagBulkSubmissionResult,
  ProviderTagActiveView,
  ProviderTagSubmissionInput,
  ProviderTagSubmissionResult,
  MempoolView,
  NetworkView,
  NetworkVersionSampleView,
  ChainHealthView,
  GovernanceObjectsView,
  PreReleaseNodeView,
  SeedNodeStatus,
  SporkGovernanceSnapshotView,
  PaginatedApiEnvelope,
  RichDistributionView,
  RichListEntry,
  StatsView,
  SyncStatusView,
  SearchResultView,
  TxView,
  DashboardOverviewView,
} from '../types/api';
import type { OpenApiDocument } from '../types/openapi';
import type { PoseChainData } from '@defcon/shared/dist/contracts';

const API_BASE = import.meta.env.VITE_API_URL || '';

export async function fetchBanAttribution(params: BanAttributionQuery) {
  const { data } = await api.get('/v1/masternodes/ban-attribution', { params });
  const result = banAttributionApiResponseSchema.parse(data).data;
  if (result.proTxHash !== params.proTxHash || result.banHeight !== params.banHeight) throw new Error('Ban identity mismatch');
  return result;
}

export async function fetchBanObservations(proof: BanAttributionProof, page: number) {
  const { data } = await api.get('/v1/network-noise/pose-events', { params: {
    proTxHash: proof.proTxHash, eventBlockHeight: proof.blockHeight, eventBlockHash: proof.blockHash,
    quorumType: proof.quorumType, quorumHash: proof.quorumHash, hours: 8760, limit: 20, page,
  } });
  const result = poseObservedEventsApiResponseSchema.parse(data).data;
  if (result.page !== page || result.limit !== 20) throw new Error('Observation page mismatch');
  if (result.events.some(e => e.proTxHash !== proof.proTxHash || e.eventBlockHeight !== proof.blockHeight
    || e.eventBlockHash !== proof.blockHash || e.quorumType !== proof.quorumType || e.quorumHash !== proof.quorumHash)) {
    throw new Error('Observation anchor mismatch');
  }
  return result;
}

export async function fetchPoseChainSummary(params: { hours: number; since?: string; fromHeight?: number }): Promise<PoseChainData> {
  const { data } = await api.get<ApiEnvelope<PoseChainData>>('/v1/masternodes/pose-chain', { params: { ...params, limit: 1 } });
  if (!data.success || !data.data) throw new Error('Ban attribution unavailable');
  return data.data;
}

export async function fetchActiveMasternodeVersions() {
  const { data } = await api.get<ApiEnvelope<ActiveMasternodeVersionsView>>('/v1/node-inventory/active-versions');
  return data.data;
}

export const api = axios.create({
  baseURL: `${API_BASE}/api`,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

export async function fetchOpenApiDocument() {
  const { data } = await api.get<OpenApiDocument>('/docs/openapi.json');
  return data;
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('API Error:', error.response?.data || error.message);
    return Promise.reject(error);
  }
);

// ── Typed API functions ──────────────────────────────────────────

export async function fetchStats() {
  const { data } = await api.get<ApiEnvelope<StatsView>>('/stats');
  return data.data;
}

export async function fetchDashboardOverview() {
  const { data } = await api.get<ApiEnvelope<DashboardOverviewView>>('/dashboard/overview', {
    params: { t: Date.now() },
  });
  return data.data;
}

interface BlockFilters {
  from?: number;
  to?: number;
}

export type BlocksCursor = { cursorHeight: number };
export type TransactionsCursor = { cursorBlockheight: number; cursorId: string };

export async function fetchBlocks(page = 1, limit = 20, filters: BlockFilters = {}) {
  const params: Record<string, number> = { page, limit };
  if (typeof filters.from === 'number') params.from = filters.from;
  if (typeof filters.to === 'number') params.to = filters.to;

  const { data } = await api.get<PaginatedApiEnvelope<BlockView>>('/blocks', { params });
  return data;
}

export async function fetchBlocksCursor(
  limit = 20,
  cursor: BlocksCursor | null = null,
  filters: BlockFilters = {}
) {
  const params: Record<string, string | number> = { cursor: 1, limit };
  if (cursor && typeof cursor.cursorHeight === 'number') {
    params.cursorHeight = cursor.cursorHeight;
  }
  if (typeof filters.from === 'number') params.from = filters.from;
  if (typeof filters.to === 'number') params.to = filters.to;

  const { data } = await api.get<PaginatedApiEnvelope<BlockView>>('/blocks', { params });
  return data;
}

export async function fetchLatestBlocks(count = 10) {
  const { data } = await api.get<ApiEnvelope<BlockView[]>>('/blocks/latest', { params: { count } });
  return data.data;
}

export async function fetchBlock(hashOrHeight: string) {
  const { data } = await api.get<ApiEnvelope<BlockView>>(`/block/${hashOrHeight}`);
  return data.data;
}

export async function fetchBlockTxs(hashOrHeight: string, page = 1, limit = 20) {
  const { data } = await api.get<PaginatedApiEnvelope<TxView>>(`/block/${hashOrHeight}/txs`, {
    params: { page, limit },
  });
  return data;
}

export async function fetchLatestTxs(count = 10) {
  const { data } = await api.get<ApiEnvelope<TxView[]>>('/txs/latest', { params: { count } });
  return data.data;
}

export async function fetchTransactions(page = 1, limit = 20) {
  const { data } = await api.get<PaginatedApiEnvelope<TxView>>('/txs', { params: { page, limit } });
  return data;
}

export async function fetchTransactionsCursor(limit = 20, cursor: TransactionsCursor | null = null) {
  const params: Record<string, string | number> = { cursor: 1, limit };
  if (cursor) {
    params.cursorBlockheight = cursor.cursorBlockheight;
    params.cursorId = cursor.cursorId;
  }

  const { data } = await api.get<PaginatedApiEnvelope<TxView>>('/txs', { params });
  return data;
}

export async function fetchTransaction(txid: string) {
  const { data } = await api.get<ApiEnvelope<TxView>>(`/tx/${txid}`);
  return data.data;
}

export async function fetchAddress(address: string) {
  const { data } = await api.get<ApiEnvelope<AddressBalanceView>>(`/address/${address}`);
  return data.data;
}

export async function fetchAddressGraph(
  address: string,
  options: { depth?: number; maxNodes?: number; maxEdges?: number } = {}
) {
  const params: Record<string, number> = {};
  if (typeof options.depth === 'number') params.depth = options.depth;
  if (typeof options.maxNodes === 'number') params.maxNodes = options.maxNodes;
  if (typeof options.maxEdges === 'number') params.maxEdges = options.maxEdges;

  const { data } = await api.get<ApiEnvelope<AddressGraphView>>(`/v1/address/${address}/graph`, {
    params,
  });
  return data.data;
}

export async function fetchAddressTxs(address: string, page = 1, limit = 20) {
  const { data } = await api.get<PaginatedApiEnvelope<TxView>>(`/address/${address}/txs`, {
    params: { page, limit },
  });
  return data;
}

export async function fetchRichList(page = 1, limit = 100) {
  const { data } = await api.get<PaginatedApiEnvelope<RichListEntry>>('/richlist', {
    params: { page, limit },
  });
  return data;
}

export async function fetchDistribution() {
  const { data } = await api.get<ApiEnvelope<RichDistributionView>>('/richlist/distribution');
  return data.data;
}

export async function fetchSearch(q: string) {
  const { data } = await api.get<ApiEnvelope<SearchResultView>>('/search', { params: { q } });
  return data.data;
}

export async function fetchSyncStatus() {
  const { data } = await api.get<ApiEnvelope<SyncStatusView>>('/sync');
  return data.data;
}

export async function fetchNetworkInfo() {
  const { data } = await api.get<ApiEnvelope<NetworkView>>('/network');
  return data.data;
}

export async function fetchNetworkVersionSample(hours = 24) {
  const { data } = await api.get<ApiEnvelope<NetworkVersionSampleView>>('/v1/node-inventory/versions', {
    params: { hours },
  });
  return data.data;
}

export async function fetchChainHealth() {
  const { data } = await api.get<ApiEnvelope<ChainHealthView>>('/network/chain-health');
  return data.data;
}

export async function fetchSeedNodes() {
  const { data } = await api.get<ApiEnvelope<SeedNodeStatus[]>>('/network/seed-nodes', {
    params: { t: Date.now() },
  });
  return data.data;
}

export async function fetchDnsSeederNodes() {
  // DNS seeder snapshots may change independently of the SPA bundle. Always
  // bypass browser/CDN response caches; the API still coalesces upstream work.
  const { data } = await api.get('/network/dns-seeder-nodes', {
    params: { t: Date.now() },
  });
  return dnsSeederNodesApiResponseSchema.parse(data);
}

export async function fetchPreReleaseNodes() {
  const { data } = await api.get<ApiEnvelope<PreReleaseNodeView[]>>('/network/pre-release-nodes', {
    params: { t: Date.now() },
  });
  return data.data;
}

export async function fetchSporkSnapshot() {
  const { data } = await api.get<ApiEnvelope<SporkGovernanceSnapshotView>>('/v1/network/sporks');
  return data.data;
}

export async function fetchGovernanceObjects(options: {
  signal?: 'all' | 'valid' | 'funding' | 'delete' | 'endorsed';
  objectType?: 'all' | 'proposals' | 'triggers';
  limit?: number;
  includeRaw?: boolean;
} = {}) {
  const params: Record<string, string | number | boolean> = {};
  if (options.signal) params.signal = options.signal;
  if (options.objectType) params.objectType = options.objectType;
  if (typeof options.limit === 'number') params.limit = options.limit;
  if (typeof options.includeRaw === 'boolean') params.includeRaw = options.includeRaw;

  const { data } = await api.get<ApiEnvelope<GovernanceObjectsView>>('/v1/network/governance/objects', { params });
  return data.data;
}

export async function fetchMempool(limit = 20) {
  const { data } = await api.get<ApiEnvelope<MempoolView>>('/mempool', { params: { limit } });
  return data.data;
}

export async function fetchMasternodes() {
  const { data } = await api.get<ApiEnvelope<MasternodesView>>('/masternodes');
  return data.data;
}

export async function fetchMasternodeSummary() {
  const { data } = await api.get<ApiEnvelope<MasternodeSummaryView>>('/masternodes/summary');
  return data.data;
}

export async function fetchMasternodeDistribution() {
  const { data } = await api.get<ApiEnvelope<MasternodeDistributionView>>('/masternodes/distribution');
  return data.data;
}

export async function fetchMasternodeNodes(options: {
  page?: number;
  limit?: number;
  country?: string | null;
  excludeCountries?: string | null;
  provider?: string | null;
  source?: 'all' | 'tagged' | 'auto';
} = {}) {
  const params: Record<string, string | number> = {};
  if (typeof options.page === 'number') params.page = options.page;
  if (typeof options.limit === 'number') params.limit = options.limit;
  if (options.country) params.country = options.country;
  if (options.excludeCountries) params.excludeCountries = options.excludeCountries;
  if (options.provider) params.provider = options.provider;
  if (options.source && options.source !== 'all') params.source = options.source;

  const { data } = await api.get<ApiEnvelope<MasternodeNodesView>>('/masternodes/nodes', { params });
  return data.data;
}

export async function fetchMasternodeHealth(hours = 168, bucket?: 'hour' | 'day', topN = 10) {
  const params: Record<string, string | number> = { hours, topN };
  if (bucket) params.bucket = bucket;
  const { data } = await api.get<ApiEnvelope<MasternodeHealthView>>('/v1/masternodes/health', {
    params,
  });
  return data.data;
}

export async function fetchMasternodeEvents(opts: {
  hours?: number;
  limit?: number;
  status?: string;
  nodeId?: string;
} = {}) {
  const params: Record<string, string | number> = {};
  if (opts.hours) params.hours = opts.hours;
  if (opts.limit) params.limit = opts.limit;
  if (opts.status) params.status = opts.status;
  if (opts.nodeId) params.nodeId = opts.nodeId;
  const { data } = await api.get<ApiEnvelope<MasternodeEventsView>>('/v1/masternodes/events', {
    params,
  });
  return data.data;
}

export async function fetchOperatorDiagnosis() {
  const { data } = await api.get<ApiEnvelope<OperatorDiagnosisData>>('/v1/masternodes/operator-diagnosis');
  return data.data;
}

export async function fetchBanWaveAnalysis(opts: {
  scope?: 'rolling' | 'q60';
  hours?: number;
  windowMinutes?: number;
  minNodes?: number;
  bucket?: 'auto' | '15min' | 'hour' | 'day';
} = {}) {
  const params: Record<string, string | number> = {};
  if (opts.scope) params.scope = opts.scope;
  if (opts.hours) params.hours = opts.hours;
  if (opts.windowMinutes) params.windowMinutes = opts.windowMinutes;
  if (opts.minNodes) params.minNodes = opts.minNodes;
  if (opts.bucket) params.bucket = opts.bucket;
  params.t = Date.now();
  const { data } = await api.get<ApiEnvelope<BanWaveAnalysisView>>('/v1/masternodes/ban-waves', {
    params,
  });
  return data.data;
}

export async function fetchNodeInventory() {
  const { data } = await api.get<ApiEnvelope<NodeInventoryView>>('/v1/node-inventory');
  return data.data;
}

export async function fetchNetworkNoiseSummary(hours = 24) {
  const { data } = await api.get<ApiEnvelope<NetworkNoiseSummaryView>>('/v1/network-noise/summary', {
    params: { hours, t: Date.now() },
  });
  return data.data;
}

export async function submitProviderTag(payload: ProviderTagSubmissionInput) {
  const { data } = await api.post<ApiEnvelope<ProviderTagSubmissionResult>>('/v1/provider-tags/submit', payload);
  return data.data;
}

export async function fetchActiveProviderTags() {
  const { data } = await api.get<ApiEnvelope<ProviderTagActiveView>>('/v1/provider-tags/active');
  return data.data;
}

export async function submitProviderTagsBulk(payload: ProviderTagBulkSubmissionInput) {
  const { data } = await api.post<ApiEnvelope<ProviderTagBulkSubmissionResult>>('/v1/provider-tags/submit-bulk', payload);
  return data.data;
}

export async function fetchMarket() {
  const { data } = await api.get<ApiEnvelope<MarketSnapshotView>>('/market');
  return data.data;
}

export async function fetchMarketHistory(days = 30) {
  const { data } = await api.get<ApiEnvelope<MarketHistoryView>>('/market/history', {
    params: { days },
  });
  return data.data;
}

export async function fetchCoin() {
  const { data } = await api.get<ApiEnvelope<CoinConfigView>>('/coin');
  return data.data;
}

export async function fetchMigrationTransparency(count = 100) {
  const { data } = await api.get<ApiEnvelope<MigrationTransparencyView>>('/v1/migration/transparency', {
    params: { count },
  });
  return data.data;
}
