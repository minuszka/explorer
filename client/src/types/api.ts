import type {
  ActiveMasternodeVersionsContract,
  IAddress,
  IBlock,
  ITransaction,
  BanWaveAnalysisContract,
  BanWaveDetailContract,
  BanWaveDetailNodeContract,
  BanWaveTimelinePointContract,
  MasternodeAnalyticsContract,
  MasternodeBanWaveContract,
  MasternodeClusterContract,
  MasternodeClusterNodeContract,
  MasternodeCountryContract,
  MasternodeDistributionContract,
  MasternodeEventContract,
  MasternodeEventsContract,
  MasternodeHealthContract,
  MasternodeHealthSnapshotContract,
  MasternodeHealthTimelinePointContract,
  MasternodeListItemContract,
  MasternodeNodeContract,
  MasternodeNodesContract,
  MasternodeOffenderContract,
  MasternodePayloadContract,
  MasternodePoseWatchEntryContract,
  MasternodeProviderContract,
  MasternodeSummaryContract,
  NodeInventoryChainStatusContract,
  NodeInventoryContract,
  NodeInventoryNodeContract,
  NetworkNoiseLevelContract,
  NetworkNoiseNodeContract,
  NetworkNoiseSignalContract,
  NetworkNoiseSummaryContract,
  NetworkNoiseTimelineEntryContract,
  NetworkVersionSampleContract,
  NetworkVersionSampleNodeContract,
  SearchResultContract,
  StatsDataContract,
} from '@defcon/shared';

export type ActiveMasternodeVersionsView = ActiveMasternodeVersionsContract;

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface CursorMeta {
  mode: 'cursor';
  hasMore: boolean;
  next: Record<string, string | number> | null;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

export interface PaginatedApiEnvelope<T> extends ApiEnvelope<T[]> {
  pagination?: PaginationMeta;
  cursor?: CursorMeta;
  filters?: {
    from: number | null;
    to: number | null;
  };
}

export type AddressBalanceView = IAddress & {
  balance: number;
  totalReceived: number;
  totalSent: number;
  balanceSat: string;
  totalReceivedSat: string;
  totalSentSat: string;
};

export interface AddressGraphNodeView {
  id: string;
  address: string;
  balance: number;
  txCount: number;
  isRoot: boolean;
  depth: number;
  group: number;
}

export interface AddressGraphEdgeView {
  source: string;
  target: string;
  txCount: number;
  totalAmount: number;
  lastBlocktime: number | null;
}

export interface AddressGraphView {
  address: string;
  depth: number;
  maxNodes: number;
  maxEdges: number;
  nodeCount: number;
  edgeCount: number;
  nodes: AddressGraphNodeView[];
  edges: AddressGraphEdgeView[];
}

export type BlockView = IBlock & {
  confirmations: number;
  reward: number;
  totalValueOut: number;
  rewardSat: string;
  totalValueOutSat: string;
};

export type TxView = ITransaction & {
  confirmations: number;
  totalValueIn: number;
  totalValueOut: number;
  fee: number;
  isDonation?: boolean;
  donationAmount?: number;
  totalValueInSat: string;
  totalValueOutSat: string;
  feeSat: string;
  vin: Array<
    ITransaction['vin'][number] & {
      value?: number;
      valueSat?: string;
    }
  >;
  vout: Array<
    ITransaction['vout'][number] & {
      value?: number;
      valueSat: string;
    }
  >;
};

export interface BlockListItemView {
  hash: string;
  height: number;
  time: number;
  nTx: number;
  confirmations: number;
  difficulty: number;
  totalValueOut: number;
  reward: number;
  minedBy: string | null;
  size: number;
}

export interface TxListItemView {
  txid: string;
  blockheight: number;
  blocktime: number;
  confirmations: number;
  totalValueIn?: number;
  totalValueOut: number;
  fee: number;
  isCoinbase: boolean;
  isDonation?: boolean;
  donationAmount?: number;
  size?: number;
}

export type DashboardBlockView = Pick<
  BlockListItemView,
  'hash' | 'height' | 'time' | 'nTx' | 'confirmations' | 'reward' | 'minedBy' | 'size'
>;

export type DashboardTxView = Pick<
  TxListItemView,
  'txid' | 'blockheight' | 'blocktime' | 'confirmations' | 'totalValueOut' | 'isCoinbase' | 'isDonation' | 'donationAmount'
>;

export type StatsView = StatsDataContract;

export interface SyncStatusView {
  isRunning: boolean;
  lastSyncedHeight: number;
  daemonHeight: number;
  rpcConnected?: boolean;
  blocksRemaining: number;
  progress: number;
  error: string | null;
  errorCode?: 'SYNC_FAILED' | 'RPC_UNAVAILABLE' | null;
  // Optional legacy/internal fields (may be absent on public /api/sync)
  startedAt?: string | null;
  heartbeatAt?: string | null;
  addressRebuildRequired?: boolean;
  satoshiDataVersion?: number;
  lastSyncedHash?: string;
  lastSyncedAt?: string | null;
  dbStats?: {
    blocks: number;
    transactions: number;
    addresses: number;
  };
}

export interface DashboardOverviewView {
  stats: StatsView;
  sync: Pick<SyncStatusView, 'isRunning' | 'lastSyncedHeight' | 'daemonHeight' | 'blocksRemaining' | 'progress' | 'error'>;
  blocks: DashboardBlockView[];
  txs: DashboardTxView[];
}

export interface RichListEntry {
  rank: number;
  address: string;
  txCount: number;
  balanceSat: string;
  balance: number;
  lastSeen: number;
}

export interface RichDistributionView {
  totalAddresses: number;
  moneySupply: number;
  top10: {
    balance: number;
    percentage: number;
  };
  top100: {
    balance: number;
    percentage: number;
  };
}

export interface MempoolTxView {
  txid: string;
  fee?: number | null;
  size?: number | null;
  time?: number | null;
  totalValueOut?: number | null;
}

export interface MempoolView {
  info: {
    size: number;
    bytes: number;
    usage: number;
    maxmempool: number;
    mempoolminfee: number;
    minrelaytxfee: number;
  };
  txs: MempoolTxView[];
}

export interface MarketSnapshotView {
  available: boolean;
  source: string | null;
  lastUpdatedAt: string | null;
  freshness: 'fresh' | 'stale' | 'unknown';
  ageSeconds: number | null;
  price: {
    usd: number | null;
    btc: number | null;
    change24h: number | null;
    volume24h: number | null;
    marketCap: number | null;
  } | null;
}

export interface MarketHistoryPoint {
  timestamp: number;
  priceUsd: number;
  volumeUsd: number | null;
}

export interface MarketHistoryView {
  available: boolean;
  source: string | null;
  days: number | null;
  points: MarketHistoryPoint[];
}

export interface NetworkPeerView {
  addr: string;
  version?: number;
  subver?: string;
  inbound?: boolean;
  startingheight?: number;
  synced_headers?: number;
  synced_blocks?: number;
  conntime?: number;
  pingtime?: number;
  countryCode: string;
  countryName: string;
  isIpv6: boolean;
}

export interface NetworkView {
  connections: number;
  protocolversion: number;
  subversion: string;
  blockHeight: number | null;
  headerHeight: number | null;
  peers: NetworkPeerView[];
}

export type NetworkVersionSampleNodeView = NetworkVersionSampleNodeContract;
export type NetworkVersionSampleView = NetworkVersionSampleContract;

export type ChainTipStatus = 'active' | 'valid-fork' | 'valid-headers' | 'invalid' | 'unknown' | 'conflicting';
export type NetworkHealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface ChainTipInfo {
  height: number;
  hash: string;
  branchlen: number;
  status: ChainTipStatus;
  peerIPs: string[];
}

export interface ChainPeerSummary {
  total: number;
  inbound: number;
  outbound: number;
  maxBanscore: number;
  bannedCount: number;
  behindCount: number;
  avgSyncedHeaders: number;
  behindPeerList: Array<{ ip: string; syncedHeaders: number }>;
}

export interface ChainSyncInfo {
  blocks: number;
  headers: number;
  verificationProgress: number;
  isSynced: boolean;
  blocksBehind: number;
}

export interface ChainHealthView {
  status: NetworkHealthStatus;
  statusReason: string;
  checkedAt: number;
  activeTip: ChainTipInfo | null;
  chainTips: ChainTipInfo[];
  forkCount: number;
  invalidCount: number;
  sync: ChainSyncInfo;
  peers: ChainPeerSummary;
}

export interface SporkGovernanceSnapshotView {
  checkedAt: number;
  capabilities: {
    sporkShow: boolean;
    sporkActive: boolean;
    governanceInfo: boolean;
  };
  sporks: {
    scheduled: Record<string, unknown> | null;
    active: Record<string, unknown> | null;
  };
  governanceInfo: Record<string, unknown> | null;
  warnings: string[];
}

export interface GovernanceObjectSummaryView {
  hash: string;
  dataHex: string | null;
  dataStringPreview: string | null;
  yesCount: number | null;
  noCount: number | null;
  abstainCount: number | null;
  absoluteYesCount: number | null;
  objectType: string | null;
  cachedFunding: boolean | null;
  cachedValid: boolean | null;
  cachedDelete: boolean | null;
  createdAt: number | null;
  raw?: unknown;
}

export interface GovernanceObjectsView {
  checkedAt: number;
  signal: string;
  objectType: string;
  limit: number;
  total: number;
  returned: number;
  objects: GovernanceObjectSummaryView[];
}

export type SeedChainStatus =
  | 'seed-baseline'
  | 'matches-seed'
  | 'seed-divergence'
  | 'hash-mismatch'
  | 'behind'
  | 'ahead'
  | 'height-match'
  | 'not-comparable';

export interface SeedNodeStatus {
  ip: string;
  label: string;
  reachable: boolean;
  fetchedAt: number;
  hostname?: string;
  updatedAt?: string;
  daemonRunning?: boolean;
  status?: string;
  blockHeight?: number;
  bestBlockHash?: string;
  connections?: number;
  version?: string;
  warnings?: string;
  chainStatus: SeedChainStatus;
  /** Positive = node is ahead of the seed baseline, negative = behind. */
  blocksDelta?: number;
  error?: string;
}

export type DnsSeederNodeView = import('@defcon/shared').DnsSeederNodeContract;

export interface PreReleaseNodeView {
  ip: string;
  port: number;
  blockHeight: number | null;
  bestBlockHash?: string | null;
  peerCount?: number | null;
  walletVersion?: string | null;
  protocolVersion?: number | null;
  syncProgress?: number | null;
  status?: string | null;
  checkedAt?: string | null;
  nodeLabel?: string | null;
  isCanonicalFallbackSeed?: boolean;
}

export type MasternodeCountryView = MasternodeCountryContract;
export type MasternodeProviderView = MasternodeProviderContract;
export type MasternodeView = MasternodeNodeContract;
export type MasternodeAnalyticsView = MasternodeAnalyticsContract;
export type MasternodesView = MasternodePayloadContract;
export type MasternodeListItemView = MasternodeListItemContract;
export type MasternodeSummaryView = MasternodeSummaryContract;
export type MasternodeDistributionView = MasternodeDistributionContract;
export type MasternodeNodesView = MasternodeNodesContract;

export interface CoinConfigView {
  NAME: string;
  TICKER: string;
  ADDRESS_PREFIX: string;
  DECIMALS: number;
  MAX_SUPPLY: number | null;
  BLOCK_TIME_SECONDS: number;
  INITIAL_REWARD: number;
  HALVING_INTERVAL: number;
  GENESIS_BLOCK_HASH: string;
  DEFAULT_RPC_PORT: number;
  DEFAULT_P2P_PORT: number;
  MASTERNODE_COLLATERAL: number;
}

export interface MigrationTransparencyItemView {
  txid: string;
  blockheight: number;
  blocktime: number;
  confirmations: number;
  toAddress: string;
  amount: number;
  amountSat: string;
}

export interface MigrationTransparencyView {
  hotWalletAddress: string;
  generatedAt: string;
  windowCount: number;
  summary: {
    outgoingTxCount: number;
    outgoingTransferCount: number;
    totalOutgoing: number;
    totalOutgoingSat: string;
    uniqueRecipients: number;
    lastPayoutAt: number | null;
  };
  items: MigrationTransparencyItemView[];
}

// ── Masternode Health ────────────────────────────────────────────

export type MasternodeEventView = MasternodeEventContract;
export type MasternodeHealthSnapshot = MasternodeHealthSnapshotContract;
export type MasternodeHealthTimelinePoint = MasternodeHealthTimelinePointContract;
export type MasternodeOffenderView = MasternodeOffenderContract;
export type MasternodeHealthView = MasternodeHealthContract;
export type MasternodeClusterNode = MasternodeClusterNodeContract;
export type MasternodeClusterView = MasternodeClusterContract;
export type MasternodePoseWatchEntry = MasternodePoseWatchEntryContract;
export type MasternodeBanWaveView = MasternodeBanWaveContract;
export type MasternodeEventsView = MasternodeEventsContract;

export type BanWaveDetailNode = BanWaveDetailNodeContract;
export type BanWaveDetail = BanWaveDetailContract;
export type BanWaveTimelinePoint = BanWaveTimelinePointContract;
export type BanWaveAnalysisView = BanWaveAnalysisContract;

export type NodeInventoryChainStatus = NodeInventoryChainStatusContract;
export type NodeInventoryNodeView = NodeInventoryNodeContract;
export type NodeInventoryView = NodeInventoryContract;
export type NetworkNoiseLevel = NetworkNoiseLevelContract;
export type NetworkNoiseNodeView = NetworkNoiseNodeContract;
export type NetworkNoiseTimelineEntry = NetworkNoiseTimelineEntryContract;
export type NetworkNoiseSignalView = NetworkNoiseSignalContract;
export type NetworkNoiseSummaryView = NetworkNoiseSummaryContract;

export interface ProviderTagSubmissionInput {
  cidr: string;
  provider: string;
  source?: 'operator_reported' | 'manual' | 'asn' | 'rdns';
  confidence?: number;
  submittedBy?: string;
  reporter?: string;
  contact?: string;
  evidenceUrl?: string;
  notes?: string;
}

export interface ProviderTagActiveRow {
  cidr: string;
  provider: string;
  source: 'operator_reported' | 'manual' | 'asn' | 'rdns';
  nodes: number;
  confidence: number | null;
  evidenceUrl?: string | null;
}

export interface ProviderTagActiveView {
  totalNodes: number;
  taggedNodes: number;
  taggedCoveragePct: number;
  rows: ProviderTagActiveRow[];
}

export interface ProviderTagSubmissionResult {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  message: string;
}

export interface ProviderTagBulkSubmissionInput {
  provider: string;
  source?: 'operator_reported' | 'manual' | 'asn' | 'rdns';
  confidence?: number;
  submittedBy?: string;
  reporter?: string;
  contact?: string;
  evidenceUrl?: string;
  notes?: string;
  rawText?: string;
  entries?: string[];
}

export interface ProviderTagBulkInvalidLine {
  lineNumber: number;
  value: string;
  reason: string;
}

export interface ProviderTagBulkSubmissionResult {
  provider: string;
  source: 'operator_reported' | 'manual' | 'asn' | 'rdns';
  confidence: number;
  totalLines: number;
  validEntries: number;
  submitted: number;
  duplicatesSkipped: number;
  alreadyExistsSkipped: number;
  invalidLines: ProviderTagBulkInvalidLine[];
  normalizedCidrs: string[];
  message: string;
}

export type SearchResultView = SearchResultContract;
