import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import FilterChips from '../../components/ui/FilterChips';
import Pager from '../../components/ui/Pager';
import SearchField from '../../components/ui/SearchField';
import SortHeader from '../../components/ui/SortHeader';
import StatePanel from '../../components/ui/StatePanel';
import { formatNumber, truncateHash } from '../../utils/formatters';
import { addressPath } from '../../utils/routes';
import {
  PAGE_SIZE,
  filterRows,
  pageCount,
  readTableState,
  sortRows,
  writeTableState,
  type MasternodeRow,
  type SortKey,
  type StatusFilter,
  type TableState,
  UNKNOWN_VERSION,
} from './masternodeRows';
import './MasternodeTable.css';

interface MasternodeTableProps {
  rows: MasternodeRow[];
  loading: boolean;
  error: string | null;
  /** True while the version snapshot is still loading: versions show as pending, not unknown. */
  versionsLoading: boolean;
  /** True when the version snapshot could not be loaded: every version then shows as unknown. */
  versionsUnavailable: boolean;
  /** A country or provider filter chosen on the page (a ranking row), shown with a way to clear it. */
  pageFilter?: ReactNode;
}

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'service', label: 'Service' },
  { key: 'status', label: 'Status' },
  { key: 'version', label: 'Version' },
  { key: 'country', label: 'Country' },
  { key: 'provider', label: 'Provider' },
  { key: 'payout', label: 'Payout' },
];

/** Height of the sticky site header, so the table header can stick just below it. */
function useSiteHeaderHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const header = document.querySelector('header.header');
    if (!header) return undefined;
    const update = () => setHeight(Math.round(header.getBoundingClientRect().height));
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(header);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);
  return height;
}

const SEARCH_DELAY_MS = 300;

function VersionCell({ row, pending }: { row: MasternodeRow; pending: boolean }) {
  if (pending) return <span className="text-muted" aria-label="Version loading">…</span>;
  if (!row.version) return <span className="text-muted">unknown</span>;
  return (
    <>
      <span className="mono">{row.version}</span>
      {row.versionState === 'stale' && (
        <span className="mn-version-stale" title="The last version report is older than the freshness window">
          stale
        </span>
      )}
    </>
  );
}

/**
 * Active masternodes with search, status filter, sortable columns and 50-row pages. The search,
 * filter, sort and page live in the URL (`?q=&status=&sort=&page=`), so a view can be shared and
 * survives a reload.
 */
export default function MasternodeTable({
  rows,
  loading,
  error,
  versionsLoading,
  versionsUnavailable,
  pageFilter,
}: MasternodeTableProps) {
  const [params, setParams] = useSearchParams();
  const state = readTableState(params);
  const cardRef = useRef<HTMLDivElement>(null);
  const headerHeight = useSiteHeaderHeight();

  const update = (patch: Partial<TableState>) =>
    setParams(writeTableState(params, { ...state, ...patch }), { replace: true });

  // The search box answers at once; the URL (and the filtering) follows after a short pause, so
  // typing does not rewrite the address on every key. A change from outside (Clear, Back) wins.
  const [draft, setDraft] = useState(state.q);
  const written = useRef(state.q);
  const pendingSearch = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (state.q !== written.current) {
      written.current = state.q;
      window.clearTimeout(pendingSearch.current);
      setDraft(state.q);
    }
  }, [state.q]);
  useEffect(() => () => window.clearTimeout(pendingSearch.current), []);
  const latestUpdate = useRef(update);
  latestUpdate.current = update;
  const onSearch = (q: string) => {
    setDraft(q);
    window.clearTimeout(pendingSearch.current);
    pendingSearch.current = window.setTimeout(() => {
      written.current = q;
      latestUpdate.current({ q, page: 1 });
    }, SEARCH_DELAY_MS);
  };

  // A version filter needs the versions: until they arrive every row would look unknown, so the
  // table would claim "no match" for a real version and "all of them" for unknown.
  const waitingForVersions = Boolean(state.version) && versionsLoading;
  const showingRows = !loading && !error && !waitingForVersions;

  // Arriving with a version filter (from the Network page or a shared link), bring the table into
  // view once, when its rows are shown: the rankings above it would otherwise fill the screen.
  const scrollOnArrival = useRef(Boolean(state.version));
  useEffect(() => {
    if (!scrollOnArrival.current || !showingRows) return;
    scrollOnArrival.current = false;
    const card = cardRef.current;
    if (!card) return;
    const siteHeader = document.querySelector('header.header')?.getBoundingClientRect().height ?? 0;
    window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - siteHeader });
  }, [showingRows]);

  // While waiting for the versions nothing is matched yet, so the status counts claim nothing either.
  const searched = useMemo(
    () => (waitingForVersions ? [] : filterRows(rows, state.q, 'all', state.version)),
    [rows, state.q, state.version, waitingForVersions],
  );
  const matched = useMemo(() => filterRows(searched, '', state.status), [searched, state.status]);
  const sorted = useMemo(() => sortRows(matched, state.sort, state.dir), [matched, state.sort, state.dir]);
  const pages = pageCount(sorted.length);
  const page = Math.min(state.page, pages);
  const visible = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const statusOptions = [
    { value: 'all' as StatusFilter, label: 'All', count: searched.length },
    { value: 'enabled' as StatusFilter, label: 'Enabled', count: searched.filter((row) => row.status === 'ENABLED').length },
    { value: 'pose_penalty' as StatusFilter, label: 'PoSe Penalty', count: searched.filter((row) => row.status === 'POSE_PENALTY').length },
  ];

  const onSort = (key: SortKey) =>
    update({ sort: key, dir: state.sort === key && state.dir === 'asc' ? 'desc' : 'asc', page: 1 });

  const onPage = (next: number) => {
    update({ page: next });
    const card = cardRef.current;
    if (card && card.getBoundingClientRect().top < headerHeight) card.scrollIntoView({ block: 'start' });
  };

  const style = { '--mn-sticky-top': `${headerHeight}px` } as CSSProperties;

  let body: ReactNode;
  if (loading) {
    body = <StatePanel title="Loading masternodes..." />;
  } else if (error) {
    body = <StatePanel tone="danger" title="Masternodes could not be loaded" description={error} />;
  } else if (waitingForVersions) {
    body = <StatePanel title="Loading versions..." description="The table is filtered by version, so it waits for them." />;
  } else if (rows.length === 0) {
    body = (
      <StatePanel
        title="No active masternodes"
        description={pageFilter ? 'No active masternode matches the chosen country or provider.' : 'The current snapshot lists no active masternode.'}
      />
    );
  } else if (matched.length === 0) {
    body = (
      <StatePanel
        title="No masternodes match"
        description={state.q ? `Nothing matches "${state.q}" with these filters.` : 'No masternode matches these filters.'}
        action={
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => {
              window.clearTimeout(pendingSearch.current);
              update({ q: '', status: 'all', version: '', page: 1 });
            }}
          >
            Clear search and filter
          </button>
        }
      />
    );
  } else {
    body = (
      <>
        <div className="mn-table-wrap">
          <table className="mn-table">
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <SortHeader
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    active={state.sort}
                    direction={state.dir}
                    onSort={onSort}
                    className={`mn-col-${column.key}`}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  <td className="mn-col-service">
                    <span className="mono">{row.service}</span>
                  </td>
                  <td className="mn-col-status">
                    <span className={`badge ${row.status === 'POSE_PENALTY' ? 'warning' : 'success'}`}>
                      {row.status === 'POSE_PENALTY' ? 'PoSe Penalty' : 'Enabled'}
                    </span>
                  </td>
                  <td className="mn-col-version" data-label="Version">
                    <VersionCell row={row} pending={versionsLoading} />
                  </td>
                  <td className="mn-col-country" data-label="Country">
                    {row.countryName || 'Unknown'}
                    {row.countryCode && <span className="text-muted mono mn-country-code">{row.countryCode}</span>}
                  </td>
                  <td className="mn-col-provider" data-label="Provider">
                    {row.provider || 'Unknown'}
                    <span className={`mn-source-tag${row.tagged ? ' tagged' : ''}`}>{row.tagged ? 'Tagged' : 'Auto'}</span>
                  </td>
                  <td className="mn-col-payout" data-label="Payout">
                    {row.payoutAddress ? (
                      <Link to={addressPath(row.payoutAddress)} className="hash mono" title={row.payoutAddress}>
                        {truncateHash(row.payoutAddress, 6)}
                      </Link>
                    ) : (
                      <span className="text-muted">Unknown</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager page={page} pages={pages} onPage={onPage} label="Masternode pages" />
      </>
    );
  }

  return (
    <div className="card mn-panel-card mn-table-card" ref={cardRef} style={style}>
      <div className="card-header">
        <div>
          <h2 className="card-title">Active Masternodes</h2>
          <p className="mn-panel-subtitle">ENABLED and POSE_PENALTY nodes from the current snapshot.</p>
        </div>
        <div className="mn-active-filter-actions">
          {showingRows && (
            <span className="mn-panel-metric" aria-live="polite">
              {matched.length === rows.length
                ? `${formatNumber(rows.length)} nodes`
                : `${formatNumber(matched.length)} of ${formatNumber(rows.length)}`}
            </span>
          )}
          {state.version && (
            <>
              <span className="badge badge-accent mn-version-badge">
                Version: {state.version === UNKNOWN_VERSION ? 'unknown' : state.version}
              </span>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => update({ version: '', page: 1 })}>
                Clear version filter
              </button>
            </>
          )}
          {pageFilter}
        </div>
      </div>
      <div className="mn-table-controls">
        <SearchField
          label="Search masternodes"
          placeholder="IP, proTx, payout address, provider or country"
          value={draft}
          onChange={onSearch}
        />
        <FilterChips label="Status" options={statusOptions} value={state.status} onChange={(status) => update({ status, page: 1 })} />
      </div>
      {versionsUnavailable && !loading && !error && (
        <p className="mn-table-note">Versions are unavailable right now, so every version shows as unknown.</p>
      )}
      {body}
    </div>
  );
}
