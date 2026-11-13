import { useParams } from 'react-router-dom';
import { HiOutlineWallet } from 'react-icons/hi2';
import AddressFlow from '../components/flow/AddressFlow';
import CopyButton from '../components/ui/CopyButton';
import './PageStyles.css';
import '../components/flow/flow.css';

export default function AddressPage() {
  const address = useParams().address ?? '';

  return (
    <div className="fade-in searchv2-page">
      <div className="page-header">
        <p className="page-kicker">
          <HiOutlineWallet aria-hidden="true" /> Address
        </p>
        {/* The address itself is the title, in full: it wraps rather than being cut off. */}
        <div className="page-title-row">
          <h1 className="page-title page-title-id mono">{address}</h1>
          {/* Keyed, so a "Copied" note for one address never shows beside the next one. */}
          <CopyButton key={address} value={address} label="address" />
        </div>
      </div>
      {/* A new address starts on page 1 with nothing carried over from the previous one. */}
      <AddressFlow key={address} address={address} />
    </div>
  );
}
