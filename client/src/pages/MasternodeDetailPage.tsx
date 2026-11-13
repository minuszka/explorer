import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HiOutlineServerStack } from 'react-icons/hi2';
import { fetchActiveMasternodeVersions, fetchMasternodeDetail, fetchMasternodeNodeEvents } from '../services/api';
import type { MasternodeDetailView } from '../types/api';
import CopyButton from '../components/ui/CopyButton';
import FavoriteButton from '../components/ui/FavoriteButton';
import StatePanel from '../components/ui/StatePanel';
import TimeText from '../components/ui/TimeText';
import { formatNumber } from '../utils/formatters';
import { addressPath, blockPath, isProTxHash, masternodePath } from '../utils/routes';
import { useFavoriteMasternodes } from '../utils/favoriteMasternodes';
import { registrationKey } from './masternodes/masternodeRows';
import { describeEvent, eventsOfRegistration, statusName } from './masternodes/nodeEvents';
import './PageStyles.css';
import './masternodes/masternodeBadges.css';
import './MasternodeDetailPage.css';

const EVENT_LIMIT = 50;

export default function MasternodeDetailPage() {
  const param = useParams().proTxHash ?? '';
  if (isProTxHash(param) && param !== param.toLowerCase()) return <Navigate to={masternodePath(param)} replace />;
  // A new node gets a fresh view, so the previous node's details never show under the new address.
  return <MasternodeDetailView key={param} proTxHash={param} />;
}

function statusBadge(status: string) {
  const key = status.toUpperCase();
  const tone = key === 'ENABLED' ? 'success' : key === 'POSE_PENALTY' ? 'warning' : key === 'POSE_BANNED' ? 'error' : '';
  return <span className={`badge ${tone}`.trim()}>{statusName(status)}</span>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mnd-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const muted = (text: string) => <span className="text-muted">{text}</span>;

function Identifier({ value, label, to }: { value: string | null | undefined; label: string; to?: string }) {
  if (!value) return muted('Unknown');
  return (
    <span className="mnd-id">
      {to ? (
        <Link to={to} className="mono">{value}</Link>
      ) : (
        <span className="mono">{value}</span>
      )}
      <CopyButton value={value} label={label} />
    </span>
  );
}

function Height({ height, none }: { height: number | null | undefined; none: string }) {
  if (height == null || height <= 0) return muted(none);
  return <Link to={blockPath(height)}>{formatNumber(height)}</Link>;
}

function NotFound({ proTxHash, invalid }: { proTxHash: string; invalid: boolean }) {
  const { isFavorite } = useFavoriteMasternodes();
  return (
    <div className="fade-in">
      <StatePanel
        className="mnd-state"
        title="Masternode not found"
        description={
          invalid
            ? `"${proTxHash}" is not a proTxHash (64 hexadecimal characters).`
            : 'The current masternode list has no registration with this proTxHash. It may have been removed or registered again under a new one.'
        }
        action={
          <div className="mnd-state-actions">
            <Link to="/masternodes" className="btn btn-sm btn-secondary">Open the Masternodes table</Link>
            {!invalid && isFavorite(proTxHash) && (
              <span className="mnd-state-star">
                In My nodes <FavoriteButton proTxHash={proTxHash} label="this proTxHash" />
              </span>
            )}
          </div>
        }
      />
    </div>
  );
}

function VersionValue({ node }: { node: MasternodeDetailView }) {
  const versionsQuery = useQuery({
    queryKey: ['masternodes', 'active-versions'],
    queryFn: fetchActiveMasternodeVersions,
    staleTime: 60_000,
  });
  if (versionsQuery.isPending) return <span className="text-muted" aria-label="Version loading">…</span>;
  if (!versionsQuery.data) return muted('Unavailable right now');
  // Matched by registration (proTxHash, else id) as in the table; never by IP.
  const row = versionsQuery.data.nodes.find((entry) => entry.id === registrationKey(node));
  if (!row?.walletVersion) return muted('unknown');
  return (
    <>
      <span className="mono">{row.walletVersion}</span>
      {row.versionState === 'stale' && (
        <span className="mn-version-stale" title="The last version report is older than the freshness window">stale</span>
      )}
    </>
  );
}

function PoseHistory({ node }: { node: MasternodeDetailView }) {
  const eventsQuery = useQuery({
    queryKey: ['masternode', node.proTxHash, 'events', node.id],
    queryFn: () => fetchMasternodeNodeEvents(node.id, EVENT_LIMIT),
    staleTime: 60_000,
    placeholderData: undefined,
  });

  let body: ReactNode;
  if (eventsQuery.isPending) {
    body = <StatePanel title="Loading PoSe history..." />;
  } else if (eventsQuery.isError) {
    body = <StatePanel tone="danger" title="PoSe history could not be loaded" description="The node details above are not affected." />;
  } else {
    const { shown, hidden } = eventsOfRegistration(eventsQuery.data, node);
    body = (
      <>
        {shown.length === 0 ? (
          <StatePanel title="No recorded events" description="Nothing was recorded for this registration in the kept period." />
        ) : (
          <div className="mnd-events-wrap">
            <table className="mnd-events">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Ban block</th>
                  <th>Recovered</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((event, index) => (
                  <tr key={String(event._id ?? `${event.detectedAt}-${index}`)}>
                    <td data-label="Time"><TimeText value={event.detectedAt} /></td>
                    <td data-label="Event">{describeEvent(event)}</td>
                    <td data-label="Ban block"><Height height={event.poseBanHeight} none="—" /></td>
                    <td data-label="Recovered">
                      {event.recoveredAt ? (
                        <>
                          <TimeText value={event.recoveredAt} />
                          {event.recoveredHeight != null && event.recoveredHeight > 0 && (
                            <> · <Link to={blockPath(event.recoveredHeight)}>{formatNumber(event.recoveredHeight)}</Link></>
                          )}
                        </>
                      ) : (
                        muted('—')
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hidden > 0 && (
          <p className="mnd-note">
            {hidden === 1 ? '1 stored event' : `${formatNumber(hidden)} stored events`} of this collateral{' '}
            {hidden === 1 ? 'is' : 'are'} not shown: {hidden === 1 ? 'it belongs' : 'they belong'} to an earlier
            registration or cannot be tied to this one.
          </p>
        )}
      </>
    );
  }

  return (
    <section className="card mnd-card" aria-labelledby="mnd-history-title">
      <div className="card-header">
        <div>
          <h2 className="card-title" id="mnd-history-title">PoSe history</h2>
          <p className="mnd-card-subtitle">
            Status changes, bans and recoveries recorded by the explorer. A ban shows the time of its ban block; other
            changes show when the explorer recorded them. Block numbers come from the chain. Events are kept for 90 days;
            the latest {EVENT_LIMIT} are shown.
          </p>
        </div>
      </div>
      {body}
    </section>
  );
}

function MasternodeDetailView({ proTxHash }: { proTxHash: string }) {
  const valid = isProTxHash(proTxHash);
  const { favorites, persistent } = useFavoriteMasternodes();
  const detailQuery = useQuery({
    queryKey: ['masternode', proTxHash],
    queryFn: () => fetchMasternodeDetail(proTxHash),
    enabled: valid,
    staleTime: 60_000,
    placeholderData: undefined,
  });

  if (!valid) return <NotFound proTxHash={proTxHash} invalid />;
  if (detailQuery.isPending) return <StatePanel title="Loading masternode..." />;
  if (detailQuery.isError) {
    return (
      <StatePanel
        tone="danger"
        title="Masternode could not be loaded"
        description={detailQuery.error instanceof Error ? detailQuery.error.message : 'The masternode service is unavailable.'}
      />
    );
  }
  const node = detailQuery.data;
  if (!node) return <NotFound proTxHash={proTxHash} invalid={false} />;

  const service = node.service || node.ip || 'Unknown service';
  const tagged = node.providerSource === 'tag';

  return (
    <div className="fade-in mnd-page">
      <div className="page-header mnd-header">
        <p className="page-kicker">
          <HiOutlineServerStack aria-hidden="true" /> Masternode
        </p>
        <div className="page-title-row">
          <h1 className="page-title page-title-id mono">{service}</h1>
          <FavoriteButton proTxHash={proTxHash} label={service} />
        </div>
        <div className="mnd-header-meta">
          {statusBadge(node.status)}
          <Link to={`/ban-detection?node=${encodeURIComponent(proTxHash)}`} className="mnd-header-link">Open in PoSe Watch</Link>
        </div>
        {!persistent && favorites.length > 0 && (
          <p className="mnd-note">This browser does not allow saving here, so your stars are kept only until the page is reloaded or closed.</p>
        )}
      </div>

      <div className="mnd-grid">
        <section className="card mnd-card" aria-labelledby="mnd-identity-title">
          <div className="card-header"><h2 className="card-title" id="mnd-identity-title">Identity</h2></div>
          <dl className="mnd-list">
            <Row label="Service"><span className="mono">{service}</span></Row>
            <Row label="Status">{statusBadge(node.status)}</Row>
            <Row label="proTxHash"><Identifier value={node.proTxHash} label="proTxHash" /></Row>
            <Row label="Collateral"><Identifier value={node.id} label="collateral outpoint" /></Row>
            <Row label="Version"><VersionValue node={node} /></Row>
            <Row label="Registered">
              <Height height={node.registeredHeight} none="Unknown" />
              {node.registeredAt != null && node.registeredAt > 0 && (
                <> · <TimeText value={node.registeredAt * 1000} /></>
              )}
            </Row>
            <Row label="PoSe penalty">{node.posePenalty != null ? formatNumber(node.posePenalty) : muted('Unknown')}</Row>
            <Row label="PoSe ban block"><Height height={node.poseBanHeight} none="Not banned" /></Row>
            <Row label="Last revived"><Height height={node.poseRevivedHeight} none="Never" /></Row>
          </dl>
        </section>

        <section className="card mnd-card" aria-labelledby="mnd-addresses-title">
          <div className="card-header"><h2 className="card-title" id="mnd-addresses-title">Addresses</h2></div>
          <dl className="mnd-list">
            <Row label="Payout"><Identifier value={node.payoutAddress} label="payout address" to={node.payoutAddress ? addressPath(node.payoutAddress) : undefined} /></Row>
            <Row label="Owner"><Identifier value={node.ownerAddress} label="owner address" to={node.ownerAddress ? addressPath(node.ownerAddress) : undefined} /></Row>
            <Row label="Collateral"><Identifier value={node.collateralAddress} label="collateral address" to={node.collateralAddress ? addressPath(node.collateralAddress) : undefined} /></Row>
            <Row label="Voting"><Identifier value={node.votingAddress} label="voting address" to={node.votingAddress ? addressPath(node.votingAddress) : undefined} /></Row>
            <Row label="Operator key"><Identifier value={node.operatorPubkey} label="operator key" /></Row>
          </dl>
        </section>

        <section className="card mnd-card" aria-labelledby="mnd-placement-title">
          <div className="card-header"><h2 className="card-title" id="mnd-placement-title">Placement</h2></div>
          <dl className="mnd-list">
            <Row label="Country">
              {node.countryName || muted('Unknown')}
              {node.countryCode && <span className="text-muted mono mnd-code">{node.countryCode}</span>}
            </Row>
            <Row label="Provider">
              {node.provider || muted('Unknown')}
              <span className={`mn-source-tag${tagged ? ' tagged' : ''}`}>{tagged ? 'Tagged' : 'Auto'}</span>
              {tagged && node.providerTagCidr && <span className="text-muted mono mnd-code">{node.providerTagCidr}</span>}
            </Row>
            <Row label="Network">
              {node.asn != null ? `AS${node.asn}` : muted('Unknown')}
              {node.asnOrg && <span className="text-muted mnd-code">{node.asnOrg}</span>}
            </Row>
          </dl>
        </section>
      </div>

      <PoseHistory node={node} />
    </div>
  );
}
