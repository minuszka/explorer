import type { ActiveMasternodeVersionsView, MasternodesView } from '../../types/api';

// The full snapshot (`/api/masternodes`) carries proTxHash and the payout address; the paged list does not.
type MasternodeNode = MasternodesView['nodes'][number];
type VersionNode = ActiveMasternodeVersionsView['nodes'][number];

export type StatusFilter = 'all' | 'enabled' | 'pose_penalty';
export type SortKey = 'service' | 'status' | 'version' | 'country' | 'provider' | 'payout';
export type SortDirection = 'asc' | 'desc';

export interface TableState {
  q: string;
  status: StatusFilter;
  /** An exact wallet version to show, or 'unknown' for nodes without one; '' shows every version. */
  version: string;
  sort: SortKey;
  dir: SortDirection;
  page: number;
}

export interface MasternodeRow {
  id: string;
  service: string;
  status: 'ENABLED' | 'POSE_PENALTY';
  proTxHash: string | null;
  payoutAddress: string | null;
  countryCode: string;
  countryName: string;
  provider: string;
  tagged: boolean;
  /** The wallet version last reported at this node's address while this registration held it; null when unknown. */
  version: string | null;
  versionState: 'fresh' | 'stale' | 'unknown';
  ipKey: number[] | null;
  port: number | null;
}

export const PAGE_SIZE = 50;
const SORT_KEYS: SortKey[] = ['service', 'status', 'version', 'country', 'provider', 'payout'];
const STATUS_FILTERS: StatusFilter[] = ['all', 'enabled', 'pose_penalty'];
export const DEFAULT_STATE: TableState = { q: '', status: 'all', version: '', sort: 'service', dir: 'asc', page: 1 };
export const UNKNOWN_VERSION = 'unknown';

/**
 * Both endpoints name a registration by proTxHash, else by id (masternodeVersions.service builds its
 * rows from the same enriched node list). They are two requests, so a registration that appears in
 * only one of them simply has no version: never matched by IP.
 */
export function registrationKey(node: { proTxHash?: string | null; id: string }): string {
  return node.proTxHash || node.id;
}

function activeStatus(status: string | null | undefined): MasternodeRow['status'] | null {
  const normalized = String(status || '').trim().toUpperCase();
  return normalized === 'ENABLED' || normalized === 'POSE_PENALTY' ? normalized : null;
}

function ipv4Key(ip: string | null | undefined): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  return match ? match.slice(1).map(Number) : null;
}

function serviceText(node: MasternodeNode): string {
  if (node.ip) return node.port != null ? `${node.ip}:${node.port}` : node.ip;
  return node.service || 'Unknown';
}

/**
 * Active masternodes (ENABLED and POSE_PENALTY) with their last-known version. Without a version
 * snapshot, or without a matching registration in it, the version is unknown: never matched by IP.
 */
export function buildRows(nodes: MasternodeNode[], versions: VersionNode[] | null | undefined): MasternodeRow[] {
  const versionByKey = new Map((versions ?? []).map((node) => [node.id, node]));
  const rows: MasternodeRow[] = [];
  for (const node of nodes) {
    const status = activeStatus(node.status);
    if (!status) continue;
    const version = versionByKey.get(registrationKey(node));
    rows.push({
      id: node.id,
      service: serviceText(node),
      status,
      proTxHash: node.proTxHash,
      payoutAddress: node.payoutAddress,
      countryCode: node.countryCode || '',
      countryName: node.countryName || '',
      provider: node.provider || '',
      tagged: node.providerSource === 'tag',
      version: version?.walletVersion ?? null,
      versionState: version?.walletVersion ? version.versionState : 'unknown',
      ipKey: ipv4Key(node.ip),
      port: node.port,
    });
  }
  return rows;
}

/** Reads the table state from the URL; anything missing or invalid falls back to the default. */
export function readTableState(params: URLSearchParams): TableState {
  const status = params.get('status') as StatusFilter | null;
  const rawSort = params.get('sort') ?? '';
  const dir: SortDirection = rawSort.startsWith('-') ? 'desc' : 'asc';
  const sort = rawSort.replace(/^-/, '') as SortKey;
  const page = Number.parseInt(params.get('page') ?? '', 10);
  return {
    q: params.get('q') ?? '',
    status: status && STATUS_FILTERS.includes(status) ? status : DEFAULT_STATE.status,
    version: (params.get('version') ?? '').trim().slice(0, 64),
    sort: SORT_KEYS.includes(sort) ? sort : DEFAULT_STATE.sort,
    dir: SORT_KEYS.includes(sort) ? dir : DEFAULT_STATE.dir,
    page: Number.isSafeInteger(page) && page >= 1 ? page : DEFAULT_STATE.page,
  };
}

/** Writes the table state into a copy of the URL parameters, leaving defaults out. */
export function writeTableState(params: URLSearchParams, state: TableState): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string, fallback: string) => (value === fallback ? next.delete(key) : next.set(key, value));
  set('q', state.q, '');
  set('status', state.status, DEFAULT_STATE.status);
  set('version', state.version, DEFAULT_STATE.version);
  set('sort', `${state.dir === 'desc' ? '-' : ''}${state.sort}`, DEFAULT_STATE.sort);
  set('page', String(state.page), String(DEFAULT_STATE.page));
  return next;
}

/**
 * Rows matching the search (service, proTx, payout address, provider or country), the status and,
 * when given, the exact version ('unknown' for nodes without one).
 */
export function filterRows(rows: MasternodeRow[], q: string, status: StatusFilter, version = ''): MasternodeRow[] {
  const needle = q.trim().toLowerCase();
  return rows.filter((row) => {
    if (version === UNKNOWN_VERSION && row.version != null) return false;
    if (version && version !== UNKNOWN_VERSION && row.version !== version) return false;
    if (status === 'enabled' && row.status !== 'ENABLED') return false;
    if (status === 'pose_penalty' && row.status !== 'POSE_PENALTY') return false;
    if (!needle) return true;
    return [row.service, row.proTxHash, row.payoutAddress, row.provider, row.countryName, row.countryCode]
      .some((field) => field != null && field.toLowerCase().includes(needle));
  });
}

function compareNumbers(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function versionKey(version: string): number[] {
  return version.replace(/^v/i, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
}

const text = (value: string | null) => (value ?? '').toLowerCase();

function compareBy(key: SortKey, a: MasternodeRow, b: MasternodeRow): number {
  switch (key) {
    case 'service':
      if (a.ipKey && b.ipKey) return compareNumbers(a.ipKey, b.ipKey) || (a.port ?? 0) - (b.port ?? 0);
      if (a.ipKey || b.ipKey) return a.ipKey ? -1 : 1;
      return a.service.localeCompare(b.service);
    case 'status':
      return a.status.localeCompare(b.status);
    case 'version':
      return compareNumbers(versionKey(a.version ?? ''), versionKey(b.version ?? ''));
    case 'country':
      return text(a.countryName).localeCompare(text(b.countryName));
    case 'provider':
      return text(a.provider).localeCompare(text(b.provider));
    case 'payout':
      return text(a.payoutAddress).localeCompare(text(b.payoutAddress));
  }
}

function isMissing(key: SortKey, row: MasternodeRow): boolean {
  if (key === 'version') return row.version == null;
  if (key === 'payout') return !row.payoutAddress;
  if (key === 'country') return !row.countryName;
  if (key === 'provider') return !row.provider;
  return false;
}

/** Sorted by the chosen column; rows missing that value always come last; ties keep service order. */
export function sortRows(rows: MasternodeRow[], key: SortKey, dir: SortDirection): MasternodeRow[] {
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const missingA = isMissing(key, a);
    const missingB = isMissing(key, b);
    if (missingA !== missingB) return missingA ? 1 : -1;
    return sign * compareBy(key, a, b) || compareBy('service', a, b) || a.id.localeCompare(b.id);
  });
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}
