import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { BanAttributionProof } from '@defcon/shared/dist/contracts';
import { fetchBanAttribution, fetchBanObservations } from '../services/api';
import TimeText from './ui/TimeText';
import './BannedByPanel.css';

function fresh(timestamp: string | null | undefined, now: number) {
  const age = timestamp ? now - Date.parse(timestamp) : Infinity;
  return age >= -1000 && age <= 180000;
}

function Observations({ proof, enabled, now, paused }: { proof: BanAttributionProof; enabled: boolean; now: number; paused: boolean }) {
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['ban-observations', proof.proTxHash, proof.blockHash, proof.quorumType, proof.quorumHash, page],
    queryFn: () => fetchBanObservations(proof, page), enabled, retry: false,
    refetchInterval: !enabled || paused ? false : 90000 });
  const data = enabled && !query.isError && !query.isFetching && fresh(query.data?.generatedAt, now) ? query.data : undefined;
  return <div className="ban-observations">
    <p>Log observations are unverified. Matching anchors do not establish why DKG participation failed. Reporter counts can overlap between events and must not be added together.</p>
    {!data ? <p role="status">{query.isFetching ? 'Loading observations…' : 'Observations unavailable or awaiting a fresh snapshot.'}</p> : <>
      <p>{data.total} matching retained event groups · last {data.windowHours} hours · retention {data.retentionDays} days. No result does not establish no observation.</p>
      {data.events.map(event => <article key={event.eventKey}>
        <strong>{event.kind} · log_observed / unverified</strong>
        <p>{event.observerCount} distinct reporters in this event group: {event.observerNodeIds.join(', ') || 'Unknown'}</p>
        <p>Reported <TimeText value={event.lastReportedAt} />{event.hasConflictingScores ? ' · Conflicting reported scores' : ''}</p>
        {event.scoreVariants.map((score, index) => <p key={index}>Reported penalty {score.previousPenalty ?? 'Unknown'} → {score.penalty ?? 'Unknown'} · ban height {score.poseBanHeight ?? 'Unknown'} · member valid {score.memberValid === null ? 'Unknown' : String(score.memberValid)}</p>)}
      </article>)}
      <p>Page {page} · up to 20 event groups per page</p>
      <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous observations</button>{' '}
      <button type="button" disabled={page * data.limit >= data.total || page >= 10000} onClick={() => setPage(page + 1)}>Next observations</button>
    </>}
    <button type="button" disabled={!enabled || query.isFetching} onClick={() => void query.refetch()}>Refresh observations</button>
  </div>;
}

function Proof({ proof, now, paused }: { proof: BanAttributionProof; now: number; paused: boolean }) {
  const [observationsOpen, setObservationsOpen] = useState(false);
  const p = proof.penalty;
  const name = proof.quorumType === 2 ? 'Q400_60' : proof.quorumType === 7 ? 'Q60/41' : `Type ${proof.quorumType}`;
  return <div className="ban-proof">
    <details open><summary>1. Ban · chain evidence</summary>
      <p>Historical ban at <Link to={`/block/${proof.blockHash}`}>block {proof.blockHeight}</Link>. This does not describe the node's current ban state.</p>
      <p>Node: <code>{proof.proTxHash}</code></p><p>Block: <code>{proof.blockHash}</code></p>
      <p>Parent: <Link to={`/block/${proof.parentHash}`}>{proof.parentHash}</Link></p>
      <p>Block time <TimeText value={proof.blockTime} /> · scoring checked <TimeText value={proof.checkedAt} /></p>
    </details>
    <details><summary>2. Penalty · verified scoring</summary>
      <p>Previous block {p.previousBlockPenalty}; before this commitment {p.beforePenalty} → after {p.afterPenalty} / maximum {p.maxPenalty}.</p>
      <p>Nominal penalty {p.penaltyAmount} (66% rounded down); applied +{p.appliedDelta} after the cap. This commitment crossed the ban threshold.</p>
      <p>Previous ban height {p.previousBanHeight}; new ban height {p.banHeight}. Rule: <code>{proof.rule}</code>.</p>
    </details>
    <details><summary>3. DKG · {name} (type {proof.quorumType})</summary>
      <p>Commitment: <Link to={`/tx/${proof.txid}`}>{proof.txid}</Link></p>
      <p>Quorum base: <code>{proof.quorumHash}</code></p>
      <p>Member valid: false. Invalid membership alone is not a ban cause; this commitment also has verified scoring.</p>
    </details>
    <details onToggle={event => setObservationsOpen(event.currentTarget.open)}>
      <summary>4. Observations · {proof.observerCount} distinct reporters · unverified</summary>
      <Observations proof={proof} enabled={observationsOpen} now={now} paused={paused} />
    </details>
  </div>;
}

export function BannedByPanel({ identity, height, paused }: { identity: string; height: string; paused: boolean }) {
  const proTxHash = identity.toLowerCase(), banHeight = Number(height);
  const selected = /^[a-f0-9]{64}$/.test(proTxHash) && /^\d+$/.test(height)
    && Number.isInteger(banHeight) && banHeight > 0 && banHeight <= 2147483647;
  const [clock, setClock] = useState(Date.now);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => { if (selected) panelRef.current?.focus(); }, [selected, proTxHash, banHeight]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 15000); return () => window.clearInterval(timer); }, []);
  const now = Math.max(clock, Date.now());
  const query = useQuery({ queryKey: ['banned-by', proTxHash, banHeight], queryFn: () => fetchBanAttribution({ proTxHash, banHeight }),
    enabled: selected, retry: false, staleTime: 0, gcTime: 0, refetchInterval: !selected || paused ? false : 90000 });
  // Never keep old causal evidence after a failed refresh, expiry or selection change.
  const data = selected && !query.isError && !query.isFetching && fresh(query.data?.generatedAt, now) ? query.data : undefined;
  const verified = data?.status === 'verified' && fresh(data.coverage.checkedAt, now);
  return <section ref={panelRef} tabIndex={-1} className="mnh-panel banned-by-panel" aria-label="Historical ban attribution">
    <div className="mnh-panel-header"><h2 className="mnh-panel-title">BANNED_BY · historical ban</h2>
      <button type="button" disabled={!selected || query.isFetching} onClick={() => void query.refetch()}>Refresh ban evidence</button></div>
    {!selected ? <p>Select “Ban evidence” beside a node's last ban block to inspect its cause.</p> : <>
      <p className="ban-selected">Node <code>{proTxHash}</code> · requested ban block {banHeight}</p>
      {!data ? <p role="status">{query.isFetching ? 'Checking ban evidence…' : 'Unknown · ban evidence unavailable or awaiting a fresh snapshot.'}</p>
        : !verified ? <p role="status">Unknown · {data.status === 'unknown' ? data.reason.replace(/_/g, ' ') : 'collector snapshot expired'}. No publishable ban cause. Unknown does not mean no ban or commitment.</p>
        : <><strong className="ban-evidence-badge">BANNED_BY · chain · verified historical ban</strong>
          <p>{data.message}</p><p>{data.hint}</p>
          <Proof key={`${data.proof.blockHash}:${data.proof.txid}`} proof={data.proof} now={now} paused={paused} /></>}
      {data && <p>Collected prefix {data.coverage.startHeight}–{data.coverage.confirmedThroughHeight} · {data.coverage.caughtUp ? 'collected range caught up' : 'partial collected range'} · response <TimeText value={data.generatedAt} />. Collected coverage is not full historical coverage.</p>}
    </>}
  </section>;
}
