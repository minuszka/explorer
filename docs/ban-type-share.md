# Verified ban share by quorum type

PoSe Watch (`/ban-detection`) shows Q400_60 (Type 2) and Q60 (Type 7) percentages of **verified attributed ban events**, using the existing canonical PoSe API. Other quorum types remain in the denominator. Membership, invalid-member counts, observer reports and raw ban history are not causal inputs.

`GET /api/v1/masternodes/pose-chain` accepts optional `since` (ISO timestamp, not in the future) and `fromHeight` (nonnegative integer). Both are intersected with the requested hours and the collector's confirmed range. The summary and penalty coverage use the same time/height window. The UI sends the selected history start, and the activation height for Since Q60. Pagination does not truncate the quorum summary.

Disabled attribution, unavailable/stale/collecting state, failed refresh, or zero verified bans shows **Unknown**, not 0%. Unknown-penalty commitments are displayed separately; their count is not a number of unknown bans. Coverage includes verified commitment blocks, the collected height range and whether that range has caught up. A caught-up range still does not establish coverage before the collector's start height. The card expires after three minutes without a fresh response.

This change does not enable a collector or backfill, modify consensus, or deploy anything. With the default disabled collector, the KPI remains Unknown.
