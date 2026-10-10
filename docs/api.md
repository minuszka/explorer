# API

The server exposes a REST API under `/api`, a versioned namespace under `/api/v1`, a WebSocket endpoint at
`/ws`, and read-only endpoints for AI assistants under `/api/ai`. The full request and response schemas are
in the OpenAPI document:

- UI: `GET /api/docs`
- JSON: `GET /api/docs/openapi.json`

Unknown `/api/*` paths return a JSON error instead of the web client.

## Route groups

### PoSe ban analysis

`GET /api/v1/masternodes/ban-waves` accepts `scope=rolling` (default) or `scope=q60`.
The Ban Detection page defaults to Q60 history. Q60 selects confirmed bans whose
`poseBanHeight` is at least mainnet activation height **144888**; a later discovery
height does not move an older ban into this period. The activation timestamp is
read from the daemon's block header. If that lookup fails, the endpoint returns an
error or explicitly marked stale cached history. Events without a known ban height
are excluded from Q60 analysis and counted in `analysisScope.unclassifiedEvents`.

The requested `hours` window still applies (maximum 2160 hours / 90 days of retained
history). `analysisScope` describes the effective start and whether it truncates
the activation period. Current registered/active/banned/penalty counts always refer
to the full live daemon snapshot, independently of the historical scope.
When `rpcAvailable=false` or `dataStatus=stale`, these counts must be shown as unknown.

`trackedNodes` includes isolated bans as well as wave members, grouped by stable
masternode identity and ordered by distinct ban count, then latest event. Duplicate
observations of the same node and ban block count once. Current state and penalty
are nullable for unavailable or unregistered nodes. The confirmed-ban timeline
covers the selected period; the explicitly named `freshDrops24h` and
`freshDropEvents24h` fields remain 24-hour measures within the selected scope.
Auto timeline buckets use the effective duration for Q60 views.

Wave grouping remains tunable with `windowMinutes` (5–120), `minNodes` (2–50), and
`bucket`. Geographic/operator concentration is correlation, not proof of a cause.

| Group | |
|---|---|
| `/api/health` | `GET /api/health` and `/api/health/live` report MongoDB connectivity. `/api/health/ready` also checks daemon RPC and returns `ok`, `degraded` or `down`; the deploy script waits on it |
| `/api/dashboard` | Dashboard overview |
| `/api/blocks`, `/api/block` | Blocks |
| `/api/txs`, `/api/tx` | Transactions |
| `/api/address` | Addresses |
| `/api/richlist`, `/api/stats`, `/api/search` | Rich list, statistics, search |
| `/api/sync` | Indexer sync state |
| `/api/network` | Network, chain health, seed nodes and node feeds |
| `/api/mempool`, `/api/market`, `/api/coin` | Mempool, market data, coin constants |
| `/api/masternodes` | Masternodes |
| `/api/migration` | Migration transparency |
| `/api/ai` | Read-only endpoints for AI assistants (see below) |
| `/api/admin` | Admin endpoints, protected by `ADMIN_API_KEY` |

Versioned namespace:

- `/api/v1/meta`
- `/api/v1/network/*`
- `/api/v1/rewards/*`
- `/api/v1/blocks/*`, `/api/v1/txs/*`, `/api/v1/address/*`
- `/api/v1/masternodes/*`
- `/api/v1/provider-tags/*`
- `/api/v1/node-inventory` and `/api/v1/node-inventory/versions`
- `/api/v1/network-noise/summary` (public) and `/api/v1/network-noise/ingest` (per-node bearer token)
- `/api/v1/migration/*`

## Realtime WebSocket

- local: `ws://127.0.0.1:3001/ws`
- behind a TLS proxy: `wss://<your-domain>/ws`

Server events: `hello`, `sync:status`, `block:new`, `tx:new`, `pong`, `error`. Client event: `ping`.

When `CORS_ORIGINS` is set, it also decides which `Origin` values may open `/ws`.

## Provider tags

Provider attribution works by CIDR/IP rules.

Public endpoints:

- `GET /api/v1/provider-tags/active`
- `POST /api/v1/provider-tags/submit`
- `POST /api/v1/provider-tags/submit-bulk`

The bulk flow takes one entry per line (`IP`, `IP:port` or CIDR), normalizes entries to CIDR (`IP` becomes
`/32`), removes duplicates, reports invalid lines and queues everything for review (`pending`) instead of
activating it.

Admin endpoints (`x-api-key: <ADMIN_API_KEY>` or `Authorization: Bearer <ADMIN_API_KEY>`):

- `GET /api/admin/provider-tags`, `POST /api/admin/provider-tags`
- `PATCH /api/admin/provider-tags/:id/active`
- `GET /api/admin/provider-tags/submissions`
- `POST /api/admin/provider-tags/submissions/:id/approve`
- `POST /api/admin/provider-tags/submissions/:id/reject`

When the Telegram bot is enabled, single submissions (`POST /api/v1/provider-tags/submit`) are also sent to
the admin with approve and reject buttons. Bulk submissions are reviewed through the admin API only.

## Nodes and node inventory

- `GET /api/network/seed-nodes`: the three hardcoded seed nodes from DeFCoN Core `chainparamsseeds.h`. Each
  seed publishes `http://<seed>/api/seed-status.json`; the server polls it every 60 seconds and reports
  divergence only when two seeds show different hashes at the same height or their tips are more than 3
  blocks apart.
- `GET /api/network/pre-release-nodes`: the Test Nodes panel. Optional external feed at
  `PRE_RELEASE_NODES_API_URL`; `PRE_RELEASE_NODES_API_KEY` is sent as `X-API-Key` from the server only and
  never reaches the browser.
- `GET /api/network/dns-seeder-nodes`: the DNS-Seeder panel. Optional external feed at `DNS_SEEDER_API_URL`.
  The existing `success` / `data[]` envelope now also includes `meta`: DNS feed state (`ok`, `stale`,
  `disabled`), retrieval and last-attempt times, row counts, and the independent daemon peer snapshot's
  state and observation time. The crawler snapshot time and completeness remain explicitly unknown;
  fetching a feed does not establish its measurement age. Invalid feed shapes return 503, or retain a
  still-allowed old feed labelled `stale`. An empty valid feed and a disabled feed are distinct.
  Requests coalesce and keep the existing short cache, timeout, failure backoff and stale-age bounds.
  Upstream feed downloads are capped at 5 MiB; normalized output at 10,000 unique endpoints.
  Rejected, duplicate and omitted records are counted. The Nodes page manually paginates all returned endpoints.
  `isLivePeer` requires a fresh outbound `getpeerinfo` entry for the exact normalized IP and port;
  inbound connections do not verify a remote listening port. One RPC snapshot supplies height and
  version. Missing heights stay null; connection counts are never substituted for the remote node's
  peer count. Version fields identify their source. Crawler hashes and heights remain discovery metadata
  and are never combined with peer heights to assert a chain hash match. A failed RPC refresh withdraws
  direct-peer claims; the browser also expires them after 180 seconds or a failed API refresh.
  `meta.portFailureEvidence` is `unavailable`: peer absence, uptime and last-seen age cannot identify
  PORT_REFUSED / PORT_TIMEOUT, consecutive failed attempts, or agreement between independent failure
  measurements. Unknown reachability has a neutral badge and no operator-action cue. This adapter
  introduces no active port probes, scheduled collector or configuration change.
- `GET /api/network/chain-health`, `GET /api/network/ops-status`
- `GET /api/v1/node-inventory`, `GET /api/v1/node-inventory/versions`

Both external feeds return JSON: an array of node records, or an object with a `data` or `nodes` array. The
feed routes normalize the fields, enrich DNS-seeder rows with local peer metadata and live peer heights from
RPC when available, serve the last good snapshot on upstream failure while it is younger than
`NODE_INVENTORY_STALE_MAX_AGE_MS`, and return an empty list, without an upstream request, when the feed URL is
unset.

`nodeInventory.service` collects all sources every `NODE_INVENTORY_POLL_INTERVAL_MS` and stores the result in
MongoDB. The node-inventory endpoints mark nodes below `NODE_INVENTORY_MIN_VERSION` (default `23.0.0`) as
deprecated.

The public Network page uses `GET /api/v1/node-inventory/active-versions`:

- Membership comes from the current daemon snapshot (`ENABLED` + `POSE_PENALTY`),
  deduplicated by masternode identity. Banned, inactive and removed entries cannot
  re-enter through old inventory records. Active status is not proof of reachability;
  a missing crawler observation alone does not mark a masternode offline.
- Versions are joined by the current IP and port. Every known version is counted
  in its version bucket, including older observations. Missing versions are unknown;
  all active nodes stay in the denominator. Freshness is independent: only
  `lastVersionObservedAt` within the last 24 hours qualifies as fresh. Old, undated
  or future-dated observations are stale, but still count toward their last-known
  version. `recommended` and `deprecated` count all identified versions;
  `coveragePct` continues to describe fresh observation coverage.
- The response exposes `statusObservedAt`, the configured `inventoryPollSeconds`
  and `versionMaxAgeSeconds`. The browser polls every 30 seconds while visible;
  inventory collection defaults to 300 seconds. External source delays are additional.
- HTTP caching is disabled for this endpoint; daemon snapshot reuse follows
  `CACHE_TTL_SECONDS`. RPC/inventory errors return 503 rather than historical percentages.
  An empty RPC result also returns 503 because the legacy RPC adapter cannot
  distinguish an empty network from all fallback calls failing.
- The older `/versions` endpoint retains its historical IP-sample semantics.

## Network noise

Agents running next to monitored nodes push observations to `POST /api/v1/network-noise/ingest` with a
per-node bearer token; `GET /api/v1/network-noise/summary` feeds the Network Noise Monitor page. Ingest is
disabled unless `NETWORK_NOISE_MONITOR_ENABLED=true`. The contract and scoring are in
[`network-noise-monitor.md`](network-noise-monitor.md).
Both v1 batches and v2 batches with structured `poseEvents` are accepted. Public
`GET /api/v1/network-noise/pose-events` provides paginated, filterable observation
candidates with separate event/observer counts. Its evidence remains `log_observed`
and `unverified`; this collector does not establish canonical PoSe attribution.

## Canonical quorum commitments

`GET /api/v1/masternodes/pose-chain` is a public, rate-limited, no-store endpoint
for the opt-in v23 mainnet commitment collector. Query parameters: `hours` (1–8760,
default 24), `page` (1–10000, default 1), `limit` (1–50, default 10), optional
`quorumType` (0–255) and `proTxHash` (64 hex characters, normalized to lowercase).

The response separates `coverage`, quorum summaries and paginated commitments.
`ready` means the collected prefix passed canonicality checks; use
`coverage.caughtUp`, `remainingBlocks` and `confirmedThroughHeight` to assess
backfill progress. Disabled, collecting, unavailable or stale collectors return
coverage with empty evidence arrays. A reorg or collection generation change
during a query also suppresses the evidence.

Each commitment reports its block/transaction, quorum type/base/index, version,
`membershipStatus`, participant and invalid-member counts, and observer counts.
`chain_verified_membership` means ordered RPC member identities agree with the
mined payload's validity bitset. It does not by itself establish a ban, reconstruct
old PoSe scores, or explain why a DKG member was invalid. `membership_unavailable`
and `unsupported_payload` remain `unknown`; decoded `memberSlots`/`invalidSlots`
are bitset sizes, not counts of actual masternodes. Null commitments have no
participants. Observer counts use exact block/height/type/base/member matches
from unexpired, non-future penalty, ban or DKG observations and deduplicate node
IDs. Those observations retain their separate unverified evidence status.

With the separately enabled historical scoring stage, `penaltyCoverage` reports
verified, pending, unavailable, unsupported and inconsistent commitment blocks
within the requested time and height window of the confirmed collected prefix.
Commitment backfill completion does not imply penalty backfill completion.
Each row carries `penaltyAttributionStatus` and a generic gap reason. Per-member
`penaltyEvidence=chain_verified_penalty` requires verified membership and a
complete supported block replay matching historical state. `penalty` then gives
the previous block's score, the score immediately before/after this commitment,
nominal amount, actual signed delta, cap and ban heights. `causedBan=true` belongs
only to the commitment that first reaches the cap for an unbanned node. A valid
member or one absent from the unchanged registry is `not_applicable` with an
explicit `penaltyReason`; an unverified cause remains `unknown` and `penalty=null`.
Quorum summaries distinguish rule applications (including capped zero deltas),
new bans and unknown penalty commitments. The `proTxHash` filter selects whole
commitments containing that member; summary counts still describe those complete
commitments. A DKG punishment does not explain the underlying participation fault.

Configuration, retention and collector constraints are described in
[`network-noise-monitor.md`](network-noise-monitor.md#canonical-commitment-collector).

## AI endpoints and MCP

Read-only endpoints for AI assistants and bots (GET only, `Access-Control-Allow-Origin: *`):

- `GET /api/ai/lookup?q=`: an address, a 64-character transaction or block hash, or a block height
- `GET /api/ai/network`: chain tip and masternode counts
- `GET /api/ai/masternode?q=`: a masternode by IP, `IP:port` or proTxHash

Amounts in `/api/ai/*` responses are integer strings in satoshis (1 DFCN = 100,000,000 satoshis).

Discovery files are served from `client/public`: `/llms.txt`, `/llms-full.txt`, `/.well-known/llms.txt` and
`/.well-known/deftrack-ai.json`.

The `mcp/` workspace is a stdio MCP server with the tools `lookup`, `network`, `masternode` and `pose_bans`.
It sends only `GET` requests to the public API and limits itself to 20 requests per minute. Build, run and
client configuration are in [`mcp/README.md`](../mcp/README.md).
# Operator diagnosis

`GET /api/v1/masternodes/operator-diagnosis` is a no-store, rate-limited read of the
full live registered masternode list and existing retained history/inventory.
It starts no collector or network probe. A validated complete `protx list registered 1`
is required; RPC failure or incomplete state returns 503, with no stale fallback.
Successful snapshots are shared/cached for 30 seconds. The response includes
`generatedAt`, `registeredCount`, `maxPenalty`, `historySince`, `historyLimited`,
and nodes with `proTxHash`, `service`, and server-computed `operatorDiagnosis[]`.
Each diagnosis has `code`, `level`, `evidence`, `message`, `hint`, `since`, `source`,
and `operatorAction` (highlight eligibility).

- `BAN_NEXT_DKG`: unbanned and not DSL-banned, penalty at least
  `max(100, registeredCount) - floor(max(100, registeredCount) * 66 / 100)`.
  Its risk and score-decay estimate assume no new penalties/suspensions or registry
  changes; they do not predict a particular next-block ban.
- `REVIVE_LOOP`: at least three distinct recorded recoveries followed by a ban
  in 1–4 blocks, using stable proTx identity and actual event heights. History is
  limited to the most recent 10,000 retained ban documents in 90 days. Pattern
  evidence does not establish the ban cause or prove a revival script exists.
- `OLD_VERSION`: last observed major version below 23; observations older than
  24 hours are informational. Missing/future observation times are excluded.
- `WRONG_CHAIN`: last-known inventory `behind`/`hash_mismatch`. Behind is lag,
  not proof of a fork. Inventory update time is explicitly distinguished from a
  chain-probe timestamp. Version/chain observations do not qualify for orange cues.

Inventory is matched by exact IP/port and compatible registration hash. Only chain
action evidence qualifies for orange highlighting in this phase. The UI expires
action snapshots after three minutes and suppresses them on failed refreshes.
Node links use `/ban-detection?node=<proTx|IP>`; “Operator notice” copies the filtered
diagnoses and evidence times for operator review. It sends no message.
