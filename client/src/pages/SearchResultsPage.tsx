import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import { fetchSearch } from '../services/api';
import StatePanel from '../components/ui/StatePanel';
import {
  errorStatus,
  getErrorMessage,
  isNotFoundError,
  looksLikeDfcnAddress,
  looksLikeTxid,
  retryFailedRequestOnce,
} from '../components/flow/flowModel';
import { addressPath, blockPath, txPath } from '../utils/routes';
import './PageStyles.css';
import '../components/flow/flow.css';

/**
 * Resolves one query and replaces this history entry with the object's own page, so Back
 * returns to where the search started instead of bouncing through this page again.
 */
function SearchResolver({ query }: { query: string }) {
  const navigate = useNavigate();
  const searchQuery = useQuery({
    queryKey: ['search', query],
    queryFn: () => fetchSearch(query),
    retry: retryFailedRequestOnce,
  });
  const result = searchQuery.isPlaceholderData ? undefined : searchQuery.data;

  let target: string | null = null;
  if (result?.type === 'block') target = blockPath(result.result.height);
  else if (result?.type === 'transaction') target = txPath(result.result.txid);
  else if (result?.type === 'address') target = addressPath(result.result.address);
  else if (searchQuery.error) {
    // The search index may not have it yet; a txid or address still has its own page, which
    // asks the API directly and shows its own "not found" state.
    if (looksLikeTxid(query)) target = txPath(query);
    else if (looksLikeDfcnAddress(query)) target = addressPath(query);
  }

  useEffect(() => {
    if (target) navigate(target, { replace: true });
  }, [navigate, target]);

  if (target || searchQuery.isPending) {
    return <StatePanel title="Searching..." description={`Looking for "${query}" in blocks, transactions and addresses.`} />;
  }

  if (isNotFoundError(searchQuery.error)) {
    return (
      <StatePanel
        title="No results found"
        description={`No block, transaction or address matches "${query}".`}
        action={
          <div className="searchv2-state-actions">
            <Link to="/blocks" className="btn btn-secondary">Latest Blocks</Link>
            <Link to="/richlist" className="btn btn-secondary">Rich List</Link>
          </div>
        }
      />
    );
  }

  if (errorStatus(searchQuery.error) === 400) {
    return (
      <StatePanel
        title="That search is not valid"
        description={getErrorMessage(searchQuery.error, 'The search query was rejected.')}
      />
    );
  }

  return (
    <StatePanel
      tone="danger"
      title="Search is not available right now"
      description={getErrorMessage(searchQuery.error, 'The search request failed.')}
    />
  );
}

export default function SearchResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = (searchParams.get('q') || '').trim();
  const [draftQuery, setDraftQuery] = useState(query);

  useEffect(() => {
    setDraftQuery(query);
  }, [query]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = draftQuery.trim();
    setSearchParams(normalized ? { q: normalized } : {});
  };

  return (
    <div className="fade-in searchv2-page">
      <div className="page-header">
        <h1 className="page-title">
          <HiOutlineMagnifyingGlass /> Search
        </h1>
      </div>

      <div className="card searchv2-query-card">
        <form role="search" onSubmit={handleSubmit} className="searchv2-query-form">
          <div className="search-container searchv2-query-input">
            <HiOutlineMagnifyingGlass className="search-icon" />
            <input
              type="search"
              className="search-input"
              aria-label="Search the chain"
              placeholder="Block height or hash, transaction ID, or address"
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary">Search</button>
        </form>
      </div>

      {query ? (
        <SearchResolver key={query} query={query} />
      ) : (
        <StatePanel title="Enter a search query" description="Search by block height, block hash, transaction ID or address." />
      )}
    </div>
  );
}
