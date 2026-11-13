import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HiOutlineArrowsRightLeft } from 'react-icons/hi2';
import { fetchTransaction } from '../services/api';
import StatePanel from '../components/ui/StatePanel';
import TransactionFlow from '../components/flow/TransactionFlow';
import { getErrorMessage, isNotFoundError, retryFailedRequestOnce } from '../components/flow/flowModel';
import './PageStyles.css';
import '../components/flow/flow.css';

function TransactionView({ txid }: { txid: string }) {
  const txQuery = useQuery({
    queryKey: ['tx', txid],
    queryFn: () => fetchTransaction(txid),
    retry: retryFailedRequestOnce,
  });

  if (txQuery.isPending) return <StatePanel title="Loading transaction..." />;

  if (isNotFoundError(txQuery.error)) {
    return (
      <StatePanel
        title="Transaction not found"
        description="This transaction is not in the explorer's index. It may not be synced yet."
        action={<Link to="/txs" className="btn btn-secondary">Latest Transactions</Link>}
      />
    );
  }

  if (txQuery.error || !txQuery.data) {
    return (
      <StatePanel
        tone="danger"
        title="Transaction could not be loaded"
        description={getErrorMessage(txQuery.error, 'Transaction details could not be loaded.')}
      />
    );
  }

  return <TransactionFlow tx={txQuery.data} />;
}

export default function TransactionPage() {
  const txid = useParams().txid ?? '';

  return (
    <div className="fade-in searchv2-page">
      <div className="page-header">
        <h1 className="page-title">
          <HiOutlineArrowsRightLeft /> Transaction
        </h1>
        <p className="page-subtitle mono" style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>{txid}</p>
      </div>
      {/* A new txid gets a fresh view, so the previous transaction never shows under the new address. */}
      <TransactionView key={txid} txid={txid} />
    </div>
  );
}
