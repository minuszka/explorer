import {
  HiOutlineInformationCircle,
  HiOutlineShieldCheck,
  HiOutlineCube,
  HiOutlineLink,
} from 'react-icons/hi2';
import { useQuery } from '@tanstack/react-query';
import { fetchBlock, fetchCoin } from '../services/api';
import { formatNumber, formatUtcDateTime } from '../utils/formatters';
import './PageStyles.css';

export default function AboutPage() {
  const { data: coin } = useQuery({
    queryKey: ['coin'],
    queryFn: fetchCoin,
  });
  const { data: genesis } = useQuery({
    queryKey: ['block', '0'],
    queryFn: () => fetchBlock('0'),
  });

  const coinName = coin?.NAME ?? 'DeFCoN';
  const ticker = 'DFCN';
  const blockTimeSeconds = coin?.BLOCK_TIME_SECONDS ?? 150;
  const blockTimeMinutes = (blockTimeSeconds / 60).toFixed(1);
  const maxSupply = coin?.MAX_SUPPLY ?? 0;
  const maxSupplyLabel =
    typeof maxSupply === 'number' && maxSupply > 0 ? `${formatNumber(maxSupply)} ${ticker}` : 'Uncapped (fixed per-block emission)';

  const genesisTime =
    typeof genesis?.time === 'number'
      ? formatUtcDateTime(genesis.time * 1000)
      : 'N/A';

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title"><HiOutlineInformationCircle /> About {coinName}</h1>
        <p className="page-subtitle">Essential project facts and official links.</p>
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="card-header">
          <h2 className="card-title"><HiOutlineShieldCheck /> What is {coinName}?</h2>
        </div>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8, fontSize: '0.95rem' }}>
          DeFCoN is a Layer-1 blockchain focused on a masternode-based compute economy. The network combines
          Proof-of-Stake, Proof-of-Service (PoS2), and Proof-of-Resources (PoR), with governance handled by DAO voting.
        </p>
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div className="card-header">
          <h2 className="card-title"><HiOutlineCube /> Network Snapshot</h2>
        </div>
        <div className="detail-grid">
          <div className="detail-row">
            <div className="detail-label">Coin</div>
            <div className="detail-value">{coinName} ({ticker})</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Consensus</div>
            <div className="detail-value">Proof-of-Stake + Proof-of-Service (PoS2)</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Resource Validation</div>
            <div className="detail-value">Proof-of-Resources (PoR)</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Target Block Time</div>
            <div className="detail-value">~{blockTimeMinutes} minutes ({blockTimeSeconds}s)</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Max Supply</div>
            <div className="detail-value">{maxSupplyLabel}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Genesis Block</div>
            <div className="detail-value">{genesisTime}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Website</div>
            <div className="detail-value">
              <a href="https://www.dfcn.io/" target="_blank" rel="noopener noreferrer" className="hash">www.dfcn.io</a>
            </div>
          </div>
          <div className="detail-row">
            <div className="detail-label"><HiOutlineLink /> Discord</div>
            <div className="detail-value">
              <a href="https://discord.gg/WzN5jawYZk" target="_blank" rel="noopener noreferrer" className="hash">discord.gg/WzN5jawYZk</a>
            </div>
          </div>
          <div className="detail-row">
            <div className="detail-label"><HiOutlineLink /> X / Twitter</div>
            <div className="detail-value">
              <a href="https://x.com/dfcn_io" target="_blank" rel="noopener noreferrer" className="hash">x.com/dfcn_io</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
