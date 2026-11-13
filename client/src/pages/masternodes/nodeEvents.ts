import type { MasternodeDetailView, MasternodeNodeEventView } from '../../types/api';

/**
 * The events endpoint answers by node id, which is the collateral outpoint. A collateral can be
 * registered again under a new proTxHash, so its stored events may belong to an earlier
 * registration. Ban and recovery records name their proTxHash; plain status changes do not, so
 * those count only from this registration's own registration time. Anything that cannot be tied
 * to this registration is left out and counted, never shown as its history.
 * `registeredAt` is the registering block's time, or an estimate from its height when that block
 * is not indexed, and the poller stamps `detectedAt` with its own clock: near the boundary a
 * status change can fall on the wrong side by minutes. Without a registration time none counts.
 */
export function eventsOfRegistration(
  events: MasternodeNodeEventView[],
  node: Pick<MasternodeDetailView, 'proTxHash' | 'registeredAt'>,
): { shown: MasternodeNodeEventView[]; hidden: number } {
  const proTxHash = (node.proTxHash ?? '').toLowerCase();
  const registeredMs = node.registeredAt != null && node.registeredAt > 0 ? node.registeredAt * 1000 : null;
  const shown: MasternodeNodeEventView[] = [];
  let hidden = 0;
  for (const event of events) {
    const eventProTx = event.proTxHash ? event.proTxHash.toLowerCase() : null;
    if (eventProTx) {
      if (eventProTx === proTxHash) shown.push(event);
      else hidden += 1;
      continue;
    }
    const detectedMs = Date.parse(event.detectedAt);
    if (registeredMs != null && Number.isFinite(detectedMs) && detectedMs >= registeredMs) shown.push(event);
    else hidden += 1;
  }
  return { shown, hidden };
}

const STATUS_NAMES: Record<string, string> = {
  ENABLED: 'Enabled',
  POSE_PENALTY: 'PoSe Penalty',
  POSE_BANNED: 'PoSe Banned',
  NEW: 'First seen',
  REMOVED: 'Removed',
};

export function statusName(status: string | null | undefined): string {
  const key = String(status ?? '').trim().toUpperCase();
  return STATUS_NAMES[key] ?? (key || 'Unknown');
}

/** What the stored event records, in words; it adds no cause or diagnosis. */
export function describeEvent(event: MasternodeNodeEventView): string {
  if (event.eventType === 'ban') return event.eventStatus === 'recovered' ? 'PoSe ban, later recovered' : 'PoSe ban';
  if (event.eventType === 'recovery') return 'Recovery';
  return `${statusName(event.previousStatus)} → ${statusName(event.currentStatus)}`;
}
