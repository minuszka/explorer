# Configuration

The server reads the root `.env` (start from [`.env.example`](../.env.example)). Every value is validated by
`server/src/config/index.ts` at startup: if a value is invalid or a required one is missing, the server
refuses to start and lists every problem.

## Minimal development setup

```env
MONGODB_URI=mongodb://127.0.0.1:27017/defcon_explorer
RPC_HOST=127.0.0.1
RPC_PORT=8193
RPC_USER=your_rpc_user
RPC_PASS=your_rpc_password
```

Every other setting falls back to a default when it is empty or unset. The DNS-seeder and test-node feeds
stay disabled until their URLs are set.

In development, Vite proxies `/api` to the backend but not the `/ws` WebSocket: the client opens `/ws` on
the origin of `VITE_API_URL` when that is set, otherwise on the page origin.

## Production

With `NODE_ENV=production` (set in `.env` or in the environment) the server also serves the built client from
`client/dist`, so run `npm run build` first. Production additionally requires:

- `RPC_PASS` (startup fails without it)
- `PRE_RELEASE_NODES_API_KEY`, but only when `PRE_RELEASE_NODES_API_URL` is set

Also set these in production:

- `ADMIN_API_KEY` (at least 32 characters). Without it, `/api/admin/*` returns `500` and a warning is logged
  at startup.
- `CORS_ORIGINS`, listing the site's own public origin(s) (for example
  `https://example.com,https://www.example.com`) plus any other allowed origins. When it is set, it also
  decides which `Origin` values may open `/ws`, so a missing site origin breaks realtime updates while REST
  keeps working. When it is empty, cross-origin REST calls are blocked, `/ws` accepts only same-host origins,
  and a warning is logged.
- `TRUST_PROXY` set to the exact number of proxy hops in front of Node (for example `2` for Cloudflare and
  nginx). The server logs a warning when it is `true`.

## Environment variables

- Server:
  - `NODE_ENV` (`development`, `test` or `production`), `PORT` (default `3001`)
- Database:
  - `MONGODB_URI`
- Daemon RPC:
  - `RPC_HOST`, `RPC_PORT` (default `8193`), `RPC_USER`, `RPC_PASS`, `RPC_TIMEOUT`
- HTTP, proxy and rate limiting:
  - `CORS_ORIGINS` (comma-separated)
  - `TRUST_PROXY` (exact number of upstream hops; default `1`)
  - `RATE_LIMIT_MAX_PER_MINUTE` (default `1200`)
  - `RATE_LIMIT_IP_HEADERS` (default `cf-connecting-ip,x-real-ip`)
- Address:
  - `P2PKH_VERSION` (optional Base58Check P2PKH version byte, used to derive addresses for legacy P2PK
    outputs; inferred from the chain when unset)
- Sync:
  - `SYNC_INTERVAL_MS`, `REORG_MAX_DEPTH`, `ALLOW_DB_WIPE`, `AUTO_WIPE_MAX_DOCS`
- Cache and polling:
  - `CACHE_TTL_SECONDS`, `MN_POLL_INTERVAL_MS`
- Node inventory and node feeds:
  - `NODE_INVENTORY_POLL_INTERVAL_MS`
  - `NODE_INVENTORY_MIN_VERSION` (default `23.0.0`)
  - `NODE_INVENTORY_REQUEST_TIMEOUT_MS`, `NODE_INVENTORY_FAILURE_BACKOFF_MS`, `NODE_INVENTORY_STALE_MAX_AGE_MS`
  - `DNS_SEEDER_API_URL` (no default; unset disables the DNS-seeder feed)
  - `PRE_RELEASE_NODES_API_URL` (no default; unset disables the test-node feed)
  - `PRE_RELEASE_NODES_API_KEY` (server-side only; required in production when `PRE_RELEASE_NODES_API_URL`
    is set)
- Network noise:
  - `NETWORK_NOISE_MONITOR_ENABLED` (default `false`)
  - `NETWORK_NOISE_INGEST_TOKENS` (comma-separated `nodeId=token` entries; entries with tokens shorter than
    32 characters are ignored; at least one valid entry is required when the monitor is enabled)
  - `NETWORK_NOISE_OBSERVATION_TTL_DAYS`, `NETWORK_NOISE_STALE_AFTER_MS`
  - `NETWORK_NOISE_CLOCK_SKEW_MS` (default `5000`, 0–60000; allowance for agent times ahead of the
    batch's first arrival)
- Provider lookup:
  - `GEOIP_ASN_MMDB`
  - `IP_API_ENABLED`
  - `IP_API_HTTPS`, `IP_API_KEY` (`IP_API_HTTPS=true` requires `IP_API_KEY`)
  - `IP_API_BATCH_TIMEOUT_MS`, `IP_API_MAX_BATCH_PER_CYCLE`
- Market:
  - `MARKET_SOURCE` (`qutrade` or `coingecko`; default `qutrade`)
  - `COINGECKO_ID`
  - `QUTRADE_API_BASE_URL`
  - `QUTRADE_PAIR_USDT`, `QUTRADE_PAIR_BTC`, `QUTRADE_HISTORY_PAIR`, `QUTRADE_TRADES_LIMIT`
- Migration:
  - `MIGRATION_HOT_WALLET_ADDRESS`
  - `MIGRATION_HOT_WALLET_ADDRESSES` (comma-separated extra wallet-owned addresses, such as HD change
    addresses)
- Admin and integrations:
  - `ADMIN_API_KEY` (at least 32 characters)
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_ID` (set both or neither; only this Telegram user can use the bot)
  - `TELEGRAM_REINDEX_COMMAND`, `TELEGRAM_DAEMON_STATUS_COMMAND` (optional shell commands behind the bot's
    `/reindex` and `/daemonstatus`; empty disables the command)
- Frontend:
  - `VITE_PUBLIC_SITE_URL` (canonical and Open Graph base URL; the server also uses it for the
    `explorerUrl` links in `/api/ai/*`)
  - `VITE_API_URL` (API origin; empty means same origin)
  - `VITE_ENABLE_TEST_PAGE`

`VITE_*` values are read by the client build (Vite) from `client/.env` files or from the shell environment,
not from the root `.env`. `VITE_PUBLIC_SITE_URL` is also read by the server from the root `.env` for the web
client's metadata, so set it in both places. `VITE_*` values are embedded in the public bundle: never put
secrets in them.

## Running your own instance

The client ships with deftrack.xyz defaults. In a fork, replace or remove:

- the Google Analytics 4 tag (`client/index.html`, `client/public/analytics-init.js`, `client/src/App.tsx`)
- the default site URL (`DEFAULT_SITE_URL` in `shared/src/routeSeo.ts`, overridable with
  `VITE_PUBLIC_SITE_URL`) and the metadata in `client/index.html`
- the static files in `client/public` (`robots.txt`, `sitemap.xml`, `llms*.txt`, `.well-known/`)
- the API base URL in `mcp/src/index.ts`
