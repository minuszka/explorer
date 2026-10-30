# Network Noise Monitor

The Network Noise Monitor is a diagnostic view of problems that monitored DeFCoN nodes find in their own logs and RPC state, such as ChainLock conflicts, chain-tip divergence, quorum and PoSe problems, peer churn, sync stalls, and resource pressure. Agents running on the nodes classify these events and push them to the explorer. The explorer stores them, scores them, and publishes an aggregated view at `/devtools/network-noise`.

The monitor is passive. The server does not contact the reporting nodes and takes no action on them. A signal reported by several nodes at the same time is correlation, not proof of cause.

## Architecture

```text
DeFCoN node + agent (external, one per node)
  -> POST /api/v1/network-noise/ingest      Authorization: Bearer <per-node token>
DefTrack server
  -> networknoiseobservations               one document per signal, removed by a TTL index
  -> networknoisenodestates                 one document per node, latest snapshot and score
  -> poseobservations                      structured v2 event observations, separate retention
  -> GET /api/v1/network-noise/summary      public, no authentication
  -> GET /api/v1/network-noise/pose-events  public, paginated observed event candidates
Web client
  -> /devtools/network-noise                polls the summary every 60 s while the tab is visible
```

This repository does not include the node-side agent. It only defines the ingest contract below, so any agent that follows it can report. The agent decides which log lines and RPC readings count as a signal, and it assigns the signal types.

| Component | Location |
| --- | --- |
| Ingest, summary and structured event routes | `server/src/routes/v1/networkNoise.v1.routes.ts` |
| Shared v1/v2 ingest and structured event schemas | `shared/src/contracts/poseTelemetry.ts` |
| Structured observation storage and grouping | `server/src/services/poseTelemetry.service.ts`, `server/src/models/PoseObservation.ts` |
| Scoring, storage, and aggregation | `server/src/services/networkNoise.service.ts` |
| MongoDB models | `server/src/models/NetworkNoiseObservation.ts`, `server/src/models/NetworkNoiseNodeState.ts` |
| Summary response contract | `shared/src/contracts/nodeMonitoring.ts` |
| Page | `client/src/pages/NetworkNoisePage.tsx` |

## Ingest API

```http
POST /api/v1/network-noise/ingest
Content-Type: application/json
Authorization: Bearer <token>
```

The server handles a request in this order:

1. If `NETWORK_NOISE_MONITOR_ENABLED` is off, it returns `503` with code `DISABLED`.
2. It validates the body against the schema below. On failure it returns `400` with code `BAD_REQUEST` and the first validation message.
3. It looks up the token configured for the payload's `nodeId` and compares it with the bearer token in constant time. A missing, unknown, or wrong token returns `401` with code `UNAUTHORIZED`.
4. On the first request for a node after this update, the existing last sequence is fixed as a legacy baseline. Sequences at or below that baseline return `200` with `duplicate: true`; their original contents are not available for comparison.
5. Above the baseline, the server stores a permanent receipt keyed by node and sequence with a digest of the normalized batch. An already completed identical batch returns `200` with `duplicate: true`. A different payload with the same node and sequence returns `409` with code `SEQUENCE_CONFLICT`.
6. A previously unseen or incomplete batch above the baseline is processed and returns `202`. Observations use their existing idempotent keys, and the node snapshot only advances to a higher sequence. This permits recovery of a delayed batch without rewinding the snapshot.

Concurrent identical batches can both process; their observation keys remain
idempotent. A failed or interrupted batch can be retried after a newer batch.
Receipts have no TTL: deleting them would allow an old batch to be accepted again,
so operators must account for storage growth. The legacy baseline and receipts
must be preserved together with node state. Run one compatible server version
for ingest during the transition; older writers do not create receipts.

Error bodies have the form `{"success": false, "error": {"code": "...", "message": "..."}}`. A storage failure returns `500` with code `INTERNAL` and an `errorId`. Responses produced before the route handler runs do not use this shape: a body that is not valid JSON (`400`) or is larger than 100 KB (`413`) is answered by Express's default error handler, and `429` responses carry the rate limiter's plain-text message.

Limits:

- 120 ingest requests per minute per client IP, in addition to the global API limit (`RATE_LIMIT_MAX_PER_MINUTE`, default 1200). A client over either limit gets `429`.
- The request body can be at most 100 KB, the Express JSON parser default. Larger bodies get `413`.
- Each payload can carry at most 100 signals and each signal at most 20 peer IPs.

### Payload Schema (`schemaVersion` 1)

Length limits apply after leading and trailing whitespace is trimmed. Unknown fields are dropped.

| Field | Type | Rules |
| --- | --- | --- |
| `schemaVersion` | number | Must be `1` |
| `agentVersion` | string | 1-32 characters |
| `nodeId` | string | 1-64 characters from `A-Z a-z 0-9 . _ -`. It must have a token in `NETWORK_NOISE_INGEST_TOKENS` |
| `nodeRole` | string | `seed`, `fullnode`, `test_mn`, `masternode`, or `unknown` |
| `observedAt` | string | ISO 8601 date-time with `Z` or a UTC offset |
| `sequence` | integer | 0 or greater. It must increase with every batch the node sends |
| `snapshot` | object | Node state when the batch was built (see below) |
| `signals` | array | 0-100 signal objects (see below). An empty array means a clean cycle |

`snapshot` fields. Only `ip` is required; every other field may be omitted or set to `null`.

| Field | Type | Rules |
| --- | --- | --- |
| `ip` | string | IPv4 or IPv6 address. The node reports this value itself; the server does not compare it with the request's source address |
| `walletVersion` | string | Up to 64 characters |
| `blockHeight` | integer | 0 or greater |
| `bestBlockHash` | string | Up to 64 characters |
| `chainLockHeight` | integer | 0 or greater |
| `chainLockHash` | string | Up to 64 characters |
| `connections`, `inbound`, `outbound` | integer | 0 or greater |
| `syncing` | boolean | |

`signals[]` fields:

| Field | Type | Rules |
| --- | --- | --- |
| `type` | string | 1-64 characters from `a-z 0-9 _` (see [Signal Types and Scoring](#signal-types-and-scoring)) |
| `fingerprint` | string | 8-128 characters. A stable identifier the agent assigns to the normalized event |
| `count` | integer | 1-100000 occurrences in this batch |
| `firstSeenAt`, `lastSeenAt` | string | ISO 8601 date-time with `Z` or a UTC offset |
| `peerIps` | string[] | Optional. Up to 20 IPv4 or IPv6 addresses |
| `sample` | string | Optional, may be `null`. A redacted log excerpt of up to 300 characters. The whole payload is rejected if any sample is longer |

The server does not check whether the timestamps are close to the current time.

### Example

```bash
curl -X POST "https://explorer.example.com/api/v1/network-noise/ingest" \
  -H "Authorization: Bearer $NOISE_TOKEN" \
  -H "Content-Type: application/json" \
  --data @payload.json
```

`payload.json`:

```json
{
  "schemaVersion": 1,
  "agentVersion": "1.0.0",
  "nodeId": "fullnode-a",
  "nodeRole": "fullnode",
  "observedAt": "2026-09-23T09:22:07Z",
  "sequence": 1042,
  "snapshot": {
    "ip": "198.51.100.10",
    "walletVersion": "v23.0.0",
    "blockHeight": 144500,
    "bestBlockHash": "<64-character block hash>",
    "chainLockHeight": 144500,
    "chainLockHash": "<64-character block hash>",
    "connections": 12,
    "inbound": 4,
    "outbound": 8,
    "syncing": false
  },
  "signals": [
    {
      "type": "chainlock_conflict",
      "fingerprint": "3c6d1e0f9a2b4c5d6e7f8091",
      "count": 2,
      "firstSeenAt": "2026-09-23T09:21:10Z",
      "lastSeenAt": "2026-09-23T09:21:40Z",
      "sample": "AcceptBlockHeader: block <hash> is marked conflicting"
    },
    {
      "type": "peer_rejection",
      "fingerprint": "9f8e7d6c5b4a39281706f5e4",
      "count": 3,
      "firstSeenAt": "2026-09-23T09:21:05Z",
      "lastSeenAt": "2026-09-23T09:22:01Z",
      "peerIps": ["203.0.113.25", "203.0.113.40"],
      "sample": "peer=<id> disconnected: <reason>"
    }
  ]
}
```

Response (`202`):

```json
{ "success": true, "data": { "duplicate": false, "acceptedSignals": 2, "noiseScore": 54 } }
```

If the same batch is sent again, the response is `200` with `{ "duplicate": true, "acceptedSignals": 0, "noiseScore": 0 }`.

### Structured PoSe/DKG payload (`schemaVersion` 2)

Version 1 payloads remain supported. Agents must retain the exact batch for retries;
their handling of a sequence conflict must be verified separately. Version 2 carries the same batch,
snapshot and legacy `signals` fields, plus a required `poseEvents` array (0–100
entries). Each entry describes one source event, with no occurrence multiplier.
The legacy score, `activeSignals` and timeline continue to use `signals` only;
`poseEvents` do not add another copy of a signal to those metrics. A v2 cycle is
marked clean only when both arrays are empty.

| `poseEvents[]` field | Rules |
| --- | --- |
| `eventId` | Stable source record ID, 8–128 characters from `A-Z a-z 0-9 . _ : -`; unique in a batch. Keep it across retries. Derive it from the source file generation and record offset, not the legacy hash-stripped fingerprint |
| `kind` | `penalty_change`, `ban`, `recovery`, `dkg_member`, or `quorum_build_failure` |
| `eventAt` | ISO date-time from the source event, distinct from batch `observedAt` |
| `eventBlockHeight`, `eventBlockHash` | Explicit integer/64-character hex hash or `null` when unavailable; never copy the batch snapshot into these fields |
| `quorumType`, `quorumHash` | Integer 0–255 / 64-character hex hash, or `null`; numeric types are retained without assuming every type is Q60 |
| `proTxHash` | 64-character hex hash; required for member events, nullable for local quorum build failures |
| `previousPenalty`, `penalty` | Nonnegative integers or `null`; both required for `penalty_change` |
| `poseBanHeight` | Nonnegative integer or `null`; positive for `ban` |
| `memberValid` | Boolean for `dkg_member`, otherwise `null`; DKG entries also require quorum type and hash |
| `sample` | Optional redacted excerpt, at most 300 characters, or `null`; same agent redaction responsibility as legacy samples |

All fields except `sample` must be present, including explicit `null` values.
Hashes are normalized to lowercase. Safe integers are required. Unknown fields,
including any agent-supplied canonical or evidence label, are discarded. The
100 KB request body limit still applies to the combined payload.

Example entry in `poseEvents` (identifiers are illustrative):

```json
{
  "eventId": "debug-generation-4:offset-101",
  "kind": "penalty_change",
  "eventAt": "2026-10-06T12:01:00Z",
  "eventBlockHeight": 147909,
  "eventBlockHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "quorumType": 2,
  "quorumHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "proTxHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "previousPenalty": 0,
  "penalty": 145,
  "poseBanHeight": null,
  "memberValid": null,
  "sample": "redacted PoSe penalty 0 -> 145"
}
```

The v2 ingest response adds `acceptedPoseObservations`, the number of newly
inserted observer records. This is neither a ban count nor a chain-verified
penalty count. A replayed sequence returns zero. Both observation stores are
written before the node's sequence advances; a storage failure remains retryable.

### Structured observation storage and identity

`poseobservations` stores source events, agent version and role, event/report/
server-receipt times, and explicitly named `snapshotBlockHeight` /
`snapshotBlockHash`. It stores no reported IP or peer IP. Its independent
`POSE_OBSERVATION_TTL_DAYS` retention defaults to 365 days (range 1–1825), measured
from the first server receipt. Changing retention affects new records only;
replays do not extend expiry. When the stored event or report time is still in
the future, a later report of the same event can replace those timestamps and
report metadata only if both times in that single report are not in the future.
The original receipt time and expiry remain unchanged. A visible first report
is not replaced; a different incomplete event sharing a local ID is not merged.

A complete candidate identity is event block height and hash + quorum type and
base hash + proTxHash + event kind. Each reporter contributes once per candidate
and score variant, even across higher batch sequences or changed source IDs.
Conflicting score reports remain separate observations under the same candidate,
with distinct reporters counted once. Missing identity fields keep records local
to `nodeId + eventId`; nearby timestamps or snapshot heights never fill the gaps.
`quorum_build_failure` always remains a local observation, even when hashes are
available. Two quorum types or alternate block hashes produce separate candidates.

These records are **agent claims**. A full identity or several reporters does not
prove canonicality, a DKG penalty, or the root cause of member invalidity. This
stage does not query RPC, confirm commitments, retract reorged chain events, or
backfill chain history. It preserves alternate hashes for subsequent validation.

### Structured event API

`GET /api/v1/network-noise/pose-events` returns a no-store, shared-schema-validated
response. It works even when ingest is disabled. Parameters are validated rather
than clamped: `hours` 1–8760 (default 24), `page` 1–10000 (default 1), `limit` 1–100
(default 50), and optional `kind`, `quorumType`, `proTxHash`, `eventBlockHeight`,
`eventBlockHash` and `quorumHash`. Block/quorum hashes normalize to lowercase;
all supplied anchors must match exactly. Anchor matches remain unverified log
claims, including when opened from a verified BANNED_BY panel. The window uses
the source `eventAt`, excludes future events and future-dated batch `observedAt`
values, and excludes expired records even before MongoDB's TTL cleanup. Future-dated
reports remain stored and can appear once their report time has passed, if still
within the event window and retention period. Pages sort by latest event time,
then event key; they can move as new reports arrive.

The response envelope is `{ "success": true, "data": ... }`. Data contains
`generatedAt`, `windowHours`, configured `retentionDays`, pagination fields,
`total` candidate groups, `observationCount`, `uncorrelatedEvents`,
`chainVerifiedEvents: 0`, and `events`. These totals cover the filtered window,
not just the page, and do not assert total network coverage.

Each event includes its identity fields, first/last source time, latest retained
report time, distinct `observerCount` / `observerNodeIds` / `observerRoles`,
`observationCount`, `scoreVariants`, `hasConflictingScores`, and a representative
sample. Every event is labeled `evidence: "log_observed"` and
`canonicalStatus: "unverified"`. Reporter counts are distinct configured node IDs;
physical independence is not established. Logs with missing identity fields
increase `uncorrelatedEvents`, and cannot be interpreted as unique chain penalties.
The existing Ban Detection UI and ban-wave API are unchanged by this collection
stage. Legacy samples are not parsed or retrospectively promoted to v2 evidence.

## Storage

For each accepted batch:

- **Observations** (`networknoiseobservations`). Each signal becomes one document. It holds the signal fields, the node's `nodeId`, role, reported `ip` and wallet version, and the batch's chain snapshot (height, best hash, ChainLock height and hash). The document key is `sha256("<nodeId>:<sequence>:<type>:<fingerprint>")`, and the server inserts it only if the key is new, so a repeated signal within one batch is stored once. Peer IPs are deduplicated. `expiresAt` is set to `observedAt` plus `NETWORK_NOISE_OBSERVATION_TTL_DAYS`, and a MongoDB TTL index deletes the document after that time. The TTL is fixed when the document is inserted, so changing the setting affects only new observations.
- **Node state** (`networknoisenodestates`). One document per `nodeId`. The server overwrites it with the latest snapshot, `agentVersion`, `lastSequence`, `lastReportedAt` (the batch's `observedAt`), `noiseScore`, `signalCount` (the sum of `count` over the batch's signals), and `activeSignalTypes` (the batch's distinct types). A batch with no signals also sets `lastCleanAt`.

Consequences for agents and operators:

- A node's score and active signal types always come from its latest accepted batch. A clean batch resets the node to a score of 0. Its earlier observations stay in the timeline until they expire.
- Stale detection uses the agent's own clock (`observedAt`). An agent must report more often than `NETWORK_NOISE_STALE_AFTER_MS`, or the node shows as stale. A report whose `observedAt` is after server receipt, or whose signal's `firstSeenAt` or `lastSeenAt` is after receipt, or whose `firstSeenAt` is later than `lastSeenAt`, remains stale until a later valid batch replaces it. Older snapshots lack the report-time receipt check and remain stale until a new valid batch, even when they contain no signals. Clock skew can therefore temporarily make a reporting node stale.
- An agent must persist its sequence across restarts. Reusing a sequence in the receipt-tracked range with different content returns a conflict; the legacy range remains conservatively rejected. Deleting only the node state does not reset the receipt history or its baseline.
- Node state documents never expire. When you remove a node's token, it can no longer report, but it still appears in the summary as stale until you delete its state document.

## Signal Types and Scoring

The server gives each type a weight. It accepts any type name that matches the pattern and gives unlisted types a weight of 3.

| Type | Weight | Chain-related |
| --- | ---: | :---: |
| `chain_tip_divergence` | 25 | yes |
| `reorg_attempt` | 20 | yes |
| `chainlock_conflict` | 18 | yes |
| `sync_stall` | 18 | |
| `rpc_unavailable` | 18 | |
| `llmq_quorum` | 15 | |
| `clock_drift` | 15 | |
| `pose_instability` | 12 | |
| `resource_pressure` | 8 | |
| `peer_rejection` | 6 | |
| `stale_peer` | 5 | |
| `peer_churn` | 4 | |
| any other type | 3 | |

Node score for one batch:

```text
noiseScore = min(100, sum over signals of weight(type) * min(count, 5))
```

In the example above, `chainlock_conflict` contributes 18 × 2 and `peer_rejection` contributes 6 × 3, for a score of 54.

| Level | Score |
| --- | --- |
| `quiet` | 0-14 |
| `elevated` | 15-34 |
| `noisy` | 35-59 |
| `severe` | 60-79 |
| `critical` | 80-100 |

The network score (`summary.currentScore`) is the highest `noiseScore` among reporting (non-stale) nodes, and `summary.currentLevel` is its level.

## Summary API

```http
GET /api/v1/network-noise/summary?hours=24
```

- `hours` is an integer from 1 to 720 and defaults to 24. Values outside that range are clamped, and a non-numeric value falls back to 24. The window applies only to `timeline` and `recentSignals`. `summary` and `nodes` always show the latest state of each node.
- No authentication is required. The response is sent with `Cache-Control: no-store` and checked against `networkNoiseSummaryApiResponseSchema` from the shared package.
- The endpoint works even when `NETWORK_NOISE_MONITOR_ENABLED` is off, and it returns whatever is already stored.

Response shape (abridged):

```json
{
  "success": true,
  "data": {
    "generatedAt": "2026-09-23T09:23:00.000Z",
    "windowHours": 24,
    "staleAfterSeconds": 180,
    "summary": {
      "currentScore": 54,
      "currentLevel": "noisy",
      "knownNodes": 2,
      "reportingNodes": 2,
      "staleNodes": 0,
      "activeSignals": 5,
      "chainAlerts": 1
    },
    "nodes": [
      {
        "nodeId": "fullnode-a",
        "nodeRole": "fullnode",
        "walletVersion": "v23.0.0",
        "agentVersion": "1.0.0",
        "lastReportedAt": "2026-09-23T09:22:07.000Z",
        "blockHeight": 144500,
        "bestBlockHash": "<64-character block hash>",
        "chainLockHeight": 144500,
        "chainLockHash": "<64-character block hash>",
        "connections": 12,
        "inbound": 4,
        "outbound": 8,
        "syncing": false,
        "noiseScore": 54,
        "signalCount": 5,
        "activeSignalTypes": ["chainlock_conflict", "peer_rejection"],
        "lastCleanAt": null,
        "isStale": false
      }
    ],
    "timeline": [
      {
        "bucket": "2026-09-23T09:00:00.000Z",
        "signalType": "chainlock_conflict",
        "count": 2,
        "nodes": ["fullnode-a"]
      }
    ],
    "recentSignals": [
      {
        "nodeId": "fullnode-a",
        "nodeRole": "fullnode",
        "walletVersion": "v23.0.0",
        "signalType": "peer_rejection",
        "fingerprint": "9f8e7d6c5b4a39281706f5e4",
        "count": 3,
        "firstSeenAt": "2026-09-23T09:21:05.000Z",
        "lastSeenAt": "2026-09-23T09:22:01.000Z",
        "sample": "peer=<id> disconnected: <reason>",
        "blockHeight": 144500,
        "bestBlockHash": "<64-character block hash>",
        "chainLockHeight": 144500,
        "chainLockHash": "<64-character block hash>"
      }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `staleAfterSeconds` | `NETWORK_NOISE_STALE_AFTER_MS` in seconds |
| `summary.knownNodes` | All nodes that have a state document, stale ones included |
| `summary.reportingNodes` | Nodes whose `lastReportedAt` falls inside the stale threshold, was verified at receipt, and is not in the future, and whose signal times are verified, not future, and ordered |
| `summary.staleNodes` | `knownNodes - reportingNodes` |
| `summary.activeSignals` | Sum of `signalCount` over reporting nodes |
| `summary.chainAlerts` | Number of reporting nodes whose latest batch contained a chain-related type |
| `nodes` | Every known node, sorted by `noiseScore` (highest first), then by `lastReportedAt` (newest first) |
| `timeline` | Unexpired observations whose `lastSeenAt` falls in the window, whose `observedAt`, `firstSeenAt`, and `lastSeenAt` are not in the future, and whose first-seen time does not follow its last-seen time, grouped by UTC hour and `signalType`. `count` is the sum of occurrences and `nodes` lists the distinct node IDs |
| `recentSignals` | Up to 80 unexpired observations in the window, excluding future times and inverted signal intervals, newest `lastSeenAt` first |

The summary never includes the reported node IPs (`snapshot.ip`) or the signals' `peerIps`. The server stores them but does not publish them.
Future-dated reports remain stored but are not counted as fresh even after the clock catches up. A later valid batch is needed to restore the node snapshot. A zero reporting-node count does not establish a quiet network; the legacy numeric summary fields remain zero for API compatibility.

## Web Page

`/devtools/network-noise` appears in the header's Dev Tools menu. The route is served with `noindex, nofollow` (`shared/src/routeSeo.ts`). The page shows:

- summary tiles: current noise level and score, reporting and known nodes, active signals, chain alerts, and stale agents
- an hourly activity chart for the selected window (1h, 6h, 24h, or 7d), with the chain-related share highlighted
- a node table with role, version, tip, ChainLock, peer counts, score (or `STALE`), and last report time
- a recent-signal evidence list with each signal's node, wallet version, and log sample

A role filter narrows the node table. A node filter narrows both the table and the evidence list.

## Configuration

The server reads these variables once, at startup. Changing any of them requires a restart.

| Variable | Default | Description |
| --- | --- | --- |
| `NETWORK_NOISE_MONITOR_ENABLED` | `false` | Turns on the ingest endpoint. Accepts `true`/`false`, `yes`/`no`, `on`/`off`, or `1`/`0`. The summary endpoint is always served |
| `NETWORK_NOISE_INGEST_TOKENS` | empty | Comma-separated `nodeId=token` entries, for example `fullnode-a=<token>,seed-a=<token>`. The first `=` splits each entry, and tokens cannot contain commas. The server silently ignores entries without `=` and tokens shorter than 32 characters |
| `NETWORK_NOISE_OBSERVATION_TTL_DAYS` | `30` | Retention for stored observations, 1-365 days |
| `NETWORK_NOISE_STALE_AFTER_MS` | `180000` | How long a node may go without reporting before it counts as stale, 60000-3600000 ms |
| `POSE_OBSERVATION_TTL_DAYS` | `365` | Structured v2 PoSe/DKG observation retention from server receipt, 1–1825 days; separate from the legacy observation TTL |

The server refuses to start if a value is invalid or out of range, or if the monitor is enabled without at least one valid token entry.

Give each node its own random token, for example one made with `openssl rand -hex 32`. Send it only over HTTPS.

## Privacy and Security

- **The summary is public.** The summary endpoint and the page require no login. For every known node they show the `nodeId`, role, wallet and agent versions, chain tip, ChainLock, and connection counts. For recent signals they also show fingerprints and log samples. Reported node IPs and peer IPs are stored in MongoDB but left out of the summary. Register only nodes whose log content you are willing to publish, and choose node IDs that do not reveal internal host names.
- **The agent must redact.** The server stores samples exactly as it receives them. It rejects samples longer than 300 characters but removes nothing from them. Before sending, the agent must strip credentials, keys, file paths, and any address or identifier that should not be published.
- **Authentication uses static tokens.** Each token is a shared secret for one node. Requests are not signed. The legacy high-water mark and tracked batch receipts prevent reprocessing known sequences, but an unseen sequence above the baseline can be accepted out of order. To rotate a token, update `NETWORK_NOISE_INGEST_TOKENS` and restart the server.

## Limitations

The following are not implemented:

- request signing, nonces, or rejection of stale or future timestamps
- detection of gaps in `sequence`
- correlation of legacy signals across nodes, and alerting (v2 structured candidate grouping is available)
- full PoSe score/ban attribution in mixed or unsupported block contexts (restricted historical replay is available below)
- access control or server-side redaction for the summary data
- push updates (the page polls)
- a reference node agent in this repository

## Canonical commitment collector

The independent collector stores verbose daemon blocks and every `type=6`
commitment, including raw payloads when decoding or membership lookup is
unavailable. It does not derive chain facts from agent logs. It supports mainnet
Core v23.0.0, payload v1 and commitment v1–v4 according to the released
[commitment serialization](https://github.com/defcon-project/defcon/blob/v23.0.0/src/llmq/commitment.h).
It relies on the configured daemon's accepted chain, rather than independently
verifying BLS signatures. Ordered `quorum info` members must match the payload's
quorum hash/index, mined block, validity bits and unused trailing slots. Empty
member slots are never counted as participating or penalized masternodes.

The default start height is Q60 activation, but historical backfill runs only
after opt-in. Each run collects a bounded contiguous prefix through the
confirmation target, including blocks with no commitments. Block documents are
unique by hash; a partial unique index permits only one canonical block at each
height. A durable independent checkpoint advances after block persistence.
Restarting replays any block written beyond that checkpoint. A changed checkpoint
hash triggers an ancestor search, old-branch retraction and replacement replay.
Orphan documents remain as fork evidence and are excluded from the public API.
The block store has no TTL; log observations retain their existing independent TTL.

Attribution is hidden during collection, errors, excessive reorg depth, stale
checks and query-time collection generation changes. Excessive depth requires
operator review and an appropriate depth setting before collection can recover.
`ready` applies to the checked prefix, not a guarantee of full history or fresh
agent coverage. A shorter confirmation target also excludes ineligible heights.

Unavailable membership is retried from retained raw payloads in oldest-attempt
order, within a separate block budget. Failure for one quorum never discards a
different commitment's verified membership. No fallback guesses member identities
when `quorum info` cannot provide them. Decoder slot counts remain available,
while participants and invalid-member counts are zero until identities are verified.

| Variable | Default | Range / purpose |
| --- | --- | --- |
| `POSE_CHAIN_COLLECTOR_ENABLED` | `false` | Explicit opt-in, independent of log ingest |
| `POSE_CHAIN_START_HEIGHT` | `144888` | Positive integer; must match the stored checkpoint's start |
| `POSE_CHAIN_BLOCKS_PER_RUN` | `50` | 1–200 new blocks per run |
| `POSE_CHAIN_CONFIRMATIONS` | `3` | 1–100 confirmations, including the block itself |
| `POSE_CHAIN_POLL_INTERVAL_MS` | `30000` | 10000–3600000 ms; first run after 15 seconds |
| `POSE_CHAIN_REORG_MAX_DEPTH` | `128` | 1–10000 blocks of ancestor search |
| `POSE_CHAIN_MEMBERSHIP_RETRY_BLOCKS` | `5` | 0–20 old blocks per run; 0 disables retries |

Run exactly one collector process per database. In-process calls are single-flight;
the checkpoint generation and compare-and-set guards are not a distributed lease.
Review daemon load before enabling backfill: each block needs verbose data and
canonicality rechecks, and each non-null commitment needs a membership lookup.
Pruned block data prevents checkpoint advancement; unavailable historical quorum
info permits raw commitment collection with explicitly unknown membership.

The [canonical API](api.md#canonical-quorum-commitments) supplies coverage,
membership and the separately enabled historical scoring evidence below.
Complete historical coverage and the new Ban Detection UI remain further work.

### Historical penalty and ban evidence

`POSE_CHAIN_ATTRIBUTION_ENABLED=false` by default; opt-in adds a separate scoring
budget, `POSE_CHAIN_ATTRIBUTION_BLOCKS_PER_RUN=5` (1–20 commitment blocks per run).
This stage can fill scoring evidence for blocks already collected before it was
enabled. Pending/unavailable blocks are attempted in oldest-attempt order.
Commitment collection can remain ready while scoring has gaps.

The replay rule is pinned to Core `a06830fd4281a1da989bb788fdd427566060d663`.
It applies the released [PoSe processing order](https://github.com/defcon-project/defcon/blob/a06830fd4281a1da989bb788fdd427566060d663/src/evo/deterministicmns.cpp)
and validates its result against both historical lists. The supported context
has a complete verbose block with coinbase first, only transaction types 0/5/6,
all non-null commitments' ordered memberships verified, and an unchanged registry.
Provider registration/update/revoke, service or unknown transaction types,
membership gaps and unexplained state changes never produce a causal claim.

State snapshots use read-only `protx listdiff` with genesis and target **hashes**,
as supported by the pinned [RPC implementation](https://github.com/defcon-project/defcon/blob/a06830fd4281a1da989bb788fdd427566060d663/src/rpc/evo.cpp).
Both the parent and commitment block are queried. A valid response must have
base height zero, the expected target height, full added-node states and no
removed/updated entries. Only proTxHash, PoSe penalty/ban/revival and DSL ban height
are stored; service addresses, operator keys and other raw RPC fields are discarded.
Missing required historical fields or unavailable state remains explicitly unknown.
These are daemon-derived state checks, not independently verified state-root proofs.

Only a replay matching every registered node's selected state fields publishes
applications and the exact commitment that causes a new PoSe ban. Valid members
and former members absent from the registry produce no application. Prior PoSe
or DSL bans cannot be attributed again as a new DKG ban. Historical snapshots and
applications share the block's no-TTL retention and canonical/reorg lifecycle.
Unsupported or inconsistent contexts retain a gap and require a future decoder
or operator investigation; temporary state/membership availability is retried.
The observation API remains unverified and never supplies missing historical scores.

Review RPC and disk load before enabling this stage: each eligible attempt requests
two full genesis-to-block lists plus canonicality checks. It does not access wallet
RPCs or modify Core/evoDB state. Real historical availability and production load
must be measured separately before enabling it on a deployed collector.

Validation includes mined v23 fixtures, malformed/unsupported payloads, multiple
commitments per block, unavailable membership retries, observer deduplication,
reorgs and interrupted persistence/rollback recovery. The MongoDB integration
suites run only with an explicit disposable
`TEST_POSE_MONGO_URI=mongodb://127.0.0.1:<port>/deftrack_pose_test_<hex>`.
The chain suite uses a separate database suffix and both suites drop only their
isolated test databases. Build shared contracts before running the server tests.
