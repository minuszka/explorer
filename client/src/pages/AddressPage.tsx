import { useParams } from 'react-router-dom';
import { HiOutlineWallet } from 'react-icons/hi2';
import AddressFlow from '../components/flow/AddressFlow';
import './PageStyles.css';
import '../components/flow/flow.css';

export default function AddressPage() {
  const address = useParams().address ?? '';

  return (
    <div className="fade-in searchv2-page">
      <div className="page-header">
        <h1 className="page-title">
          <HiOutlineWallet /> Address
        </h1>
        <p className="page-subtitle mono" style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>{address}</p>
      </div>
      {/* A new address starts on page 1 with nothing carried over from the previous one. */}
      <AddressFlow key={address} address={address} />
    </div>
  );
}
