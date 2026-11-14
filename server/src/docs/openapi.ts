import { openApiContractSchemas, openApiSuccessResponse } from './openapiContracts';

type OpenApiDocument = {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, unknown>;
  components: {
    parameters: Record<string, unknown>;
    schemas: Record<string, unknown>;
    responses: Record<string, unknown>;
  };
};

const jsonContent = (schemaRef: string) => ({
  'application/json': {
    schema: { $ref: schemaRef },
  },
});

const OpenApiResponses = {
  ok: {
    description: 'Successful response',
    content: jsonContent('#/components/schemas/ApiSuccess'),
  },
  badRequest: {
    description: 'Validation error',
    content: jsonContent('#/components/schemas/ApiError'),
  },
  notFound: {
    description: 'Not found',
    content: jsonContent('#/components/schemas/ApiError'),
  },
  serviceUnavailable: {
    description: 'Upstream service unavailable',
    content: jsonContent('#/components/schemas/ApiError'),
  },
  internalError: {
    description: 'Internal server error',
    content: jsonContent('#/components/schemas/ApiError'),
  },
} as const;

export const openApiDocument: OpenApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'DeFCoN Explorer API',
    version: '1.0.0',
    description:
      'REST API for blockchain explorer data, network metrics, market endpoints, and v1 utility routes. ' +
      'The read-only /api/ai/* lookup endpoints for AI agents are described in /llms.txt and /.well-known/deftrack-ai.json.',
  },
  servers: [
    {
      url: '/',
      description: 'Same-origin API server',
    },
  ],
  tags: [
    { name: 'Health', description: 'Liveness and readiness checks' },
    { name: 'Dashboard', description: 'Aggregated overview for homepage widgets' },
    { name: 'Blocks', description: 'Block list and block detail endpoints' },
    { name: 'Transactions', description: 'Transaction list and transaction detail endpoints' },
    { name: 'Addresses', description: 'Address balance and address transaction history' },
    { name: 'Rich List', description: 'Largest addresses and distribution metrics' },
    { name: 'Stats', description: 'Global chain statistics' },
    { name: 'Search', description: 'Universal search endpoint for block/tx/address' },
    { name: 'Sync', description: 'Indexer sync state' },
    { name: 'Network', description: 'Peer and daemon network status' },
    { name: 'Mempool', description: 'Mempool summary and sampled transactions' },
    { name: 'Market', description: 'Market snapshot and history from configured provider' },
    { name: 'Coin', description: 'Static chain constants' },
    { name: 'Masternodes', description: 'Masternode dataset and analytics' },
    { name: 'V1', description: 'Versioned lightweight API namespace' },
    { name: 'Docs', description: 'OpenAPI spec endpoints' },
  ],
  paths: {
    '/api/docs/openapi.json': {
      get: {
        tags: ['Docs'],
        summary: 'OpenAPI JSON document',
        responses: {
          200: {
            description: 'OpenAPI document',
          },
        },
      },
    },
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness probe',
        responses: {
          200: OpenApiResponses.ok,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness probe (DB + RPC)',
        responses: {
          200: OpenApiResponses.ok,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/dashboard/overview': {
      get: {
        tags: ['Dashboard'],
        summary: 'Aggregated dashboard payload',
        responses: {
          200: OpenApiResponses.ok,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/stats': {
      get: {
        tags: ['Stats'],
        summary: 'Global chain statistics',
        responses: {
          200: openApiSuccessResponse('StatsApiResponse'),
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/sync': {
      get: {
        tags: ['Sync'],
        summary: 'Indexer sync status',
        responses: {
          200: OpenApiResponses.ok,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/search': {
      get: {
        tags: ['Search'],
        summary: 'Search by block height/hash, txid, or address',
        parameters: [{ $ref: '#/components/parameters/SearchQuery' }],
        responses: {
          200: openApiSuccessResponse('SearchApiResponse'),
          400: OpenApiResponses.badRequest,
          404: OpenApiResponses.notFound,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/coin': {
      get: {
        tags: ['Coin'],
        summary: 'Static chain constants',
        responses: {
          200: OpenApiResponses.ok,
        },
      },
    },
    '/api/blocks': {
      get: {
        tags: ['Blocks'],
        summary: 'Paginated block list',
        parameters: [
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/Limit' },
          { $ref: '#/components/parameters/FromTimestamp' },
          { $ref: '#/components/parameters/ToTimestamp' },
        ],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/blocks/latest': {
      get: {
        tags: ['Blocks'],
        summary: 'Latest blocks',
        parameters: [{ $ref: '#/components/parameters/Count' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/block/{hashOrHeight}': {
      get: {
        tags: ['Blocks'],
        summary: 'Single block by hash or height',
        parameters: [{ $ref: '#/components/parameters/HashOrHeight' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          404: OpenApiResponses.notFound,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/block/{hashOrHeight}/txs': {
      get: {
        tags: ['Blocks'],
        summary: 'Paginated transactions in block',
        parameters: [
          { $ref: '#/components/parameters/HashOrHeight' },
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/txs': {
      get: {
        tags: ['Transactions'],
        summary: 'Paginated transaction list',
        parameters: [
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/txs/latest': {
      get: {
        tags: ['Transactions'],
        summary: 'Latest transactions',
        parameters: [{ $ref: '#/components/parameters/Count' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/tx/{txid}': {
      get: {
        tags: ['Transactions'],
        summary: 'Single transaction by txid',
        parameters: [{ $ref: '#/components/parameters/Txid' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          404: OpenApiResponses.notFound,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/address/{address}': {
      get: {
        tags: ['Addresses'],
        summary: 'Address summary',
        parameters: [{ $ref: '#/components/parameters/Address' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          404: OpenApiResponses.notFound,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/address/{address}/txs': {
      get: {
        tags: ['Addresses'],
        summary: 'Address transactions',
        parameters: [
          { $ref: '#/components/parameters/Address' },
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/richlist': {
      get: {
        tags: ['Rich List'],
        summary: 'Paginated rich list',
        parameters: [
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/RichListLimit' },
        ],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/richlist/distribution': {
      get: {
        tags: ['Rich List'],
        summary: 'Top-10 and top-100 concentration',
        responses: {
          200: OpenApiResponses.ok,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/network': {
      get: {
        tags: ['Network'],
        summary: 'Daemon network and peers',
        responses: {
          200: OpenApiResponses.ok,
          503: OpenApiResponses.serviceUnavailable,
        },
      },
    },
    '/api/mempool': {
      get: {
        tags: ['Mempool'],
        summary: 'Mempool info and sampled transactions',
        parameters: [{ $ref: '#/components/parameters/MempoolLimit' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          503: OpenApiResponses.serviceUnavailable,
        },
      },
    },
    '/api/market': {
      get: {
        tags: ['Market'],
        summary: 'Current market snapshot',
        responses: {
          200: OpenApiResponses.ok,
        },
      },
    },
    '/api/market/history': {
      get: {
        tags: ['Market'],
        summary: 'Historical market chart data',
        parameters: [{ $ref: '#/components/parameters/MarketDays' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
        },
      },
    },
    '/api/masternodes': {
      get: {
        tags: ['Masternodes'],
        summary: 'Masternode enriched payload',
        responses: {
          200: openApiSuccessResponse('MasternodeApiResponse'),
          503: OpenApiResponses.serviceUnavailable,
        },
      },
    },
    '/api/masternodes/summary': {
      get: {
        tags: ['Masternodes'],
        summary: 'Masternode summary snapshot',
        responses: {
          200: openApiSuccessResponse('MasternodeSummaryApiResponse'),
          503: OpenApiResponses.serviceUnavailable,
        },
      },
    },
    '/api/masternodes/distribution': {
      get: {
        tags: ['Masternodes'],
        summary: 'Masternode country and provider distribution',
        responses: {
          200: openApiSuccessResponse('MasternodeDistributionApiResponse'),
          503: OpenApiResponses.serviceUnavailable,
        },
      },
    },
    '/api/masternodes/nodes': {
      get: {
        tags: ['Masternodes'],
        summary: 'Filtered masternode node list',
        parameters: [
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/Limit' },
          { name: 'source', in: 'query', schema: { type: 'string', enum: ['all', 'tagged', 'auto'] } },
          { name: 'country', in: 'query', schema: { type: 'string', minLength: 2, maxLength: 2 } },
          { name: 'provider', in: 'query', schema: { type: 'string', maxLength: 128 } },
          { name: 'excludeCountries', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: openApiSuccessResponse('MasternodeNodesApiResponse'),
          400: OpenApiResponses.badRequest,
          503: OpenApiResponses.serviceUnavailable,
        },
      },
    },
    '/api/v1/node-inventory/active-versions': {
      get: {
        tags: ['V1', 'Masternodes'],
        summary: 'Version distribution for current ENABLED and POSE_PENALTY masternodes',
        description: 'Counts masternode identities from the current daemon snapshot. Matches last-known versions by current IP and port, including older observations in their version buckets. All active nodes, including unknown versions, remain in the denominator. Freshness is reported separately using a 24-hour window. Active status is not a reachability probe. Returns 503 when the status snapshot or inventory cannot be read.',
        responses: {
          200: openApiSuccessResponse('ActiveMasternodeVersionsApiResponse'),
          503: OpenApiResponses.serviceUnavailable,
        },
      },
    },
    '/api/v1/node-inventory': {
      get: {
        tags: ['V1', 'Masternodes'],
        summary: 'Observed node version and chain inventory',
        parameters: [
          { name: 'version', in: 'query', schema: { type: 'string' } },
          { name: 'source', in: 'query', schema: { type: 'string' } },
          { name: 'chainStatus', in: 'query', schema: { type: 'string', enum: ['main_chain', 'ahead', 'behind', 'hash_mismatch', 'unknown'] } },
          { name: 'legacy', in: 'query', schema: { type: 'string', enum: ['1'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 500 } },
        ],
        responses: {
          200: openApiSuccessResponse('NodeInventoryApiResponse'),
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/masternodes/events': {
      get: {
        tags: ['V1', 'Masternodes'],
        summary: 'Recent masternode status-change events',
        parameters: [
          { name: 'hours', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 720, default: 168 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'nodeId', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: openApiSuccessResponse('MasternodeEventsApiResponse'),
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/masternodes/health': {
      get: {
        tags: ['V1', 'Masternodes'],
        summary: 'Masternode PoSe health snapshot',
        parameters: [
          { name: 'hours', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 720, default: 168 } },
          { name: 'bucket', in: 'query', schema: { type: 'string', enum: ['hour', 'day'] } },
          { name: 'topN', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
        ],
        responses: {
          200: openApiSuccessResponse('MasternodeHealthApiResponse'),
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/network-noise/pose-events': {
      get: {
        tags: ['V1'], summary: 'Paginated unverified PoSe log observations',
        description: 'No-store. Optional exact anchors restrict candidates; matching chain identifiers never verify a log claim.',
        parameters: [
          { name: 'hours', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 8760, default: 24 } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['penalty_change', 'ban', 'recovery', 'dkg_member', 'quorum_build_failure'] } },
          { name: 'quorumType', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 255 } },
          { name: 'proTxHash', in: 'query', schema: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } },
          { name: 'eventBlockHeight', in: 'query', schema: { type: 'integer', minimum: 0 } },
          { name: 'eventBlockHash', in: 'query', schema: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } },
          { name: 'quorumHash', in: 'query', schema: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } },
        ],
        responses: { 200: openApiSuccessResponse('PoseObservedEventsApiResponse'),
          400: OpenApiResponses.badRequest, 500: OpenApiResponses.internalError },
      },
    },
    '/api/v1/masternodes/ban-attribution': {
      get: {
        tags: ['V1', 'Masternodes'],
        summary: 'Verified BANNED_BY evidence for one identity and ban block',
        description: 'No-store, read-only lookup. Unknown is not evidence of no ban. Verified scoring does not explain the DKG fault.',
        parameters: [
          { name: 'proTxHash', in: 'query', required: true, schema: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } },
          { name: 'banHeight', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: 2147483647 } },
          { name: 'blockHash', in: 'query', description: 'Optional canonical hash pin; a mismatch suppresses evidence.',
            schema: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } },
        ],
        responses: { 200: openApiSuccessResponse('BanAttributionApiResponse'),
          400: OpenApiResponses.badRequest, 500: OpenApiResponses.internalError },
      },
    },
    '/api/v1/masternodes/ban-waves': {
      get: {
        tags: ['V1', 'Masternodes'],
        summary: 'PoSe ban-wave analysis',
        parameters: [
          { name: 'scope', in: 'query', description: 'q60 selects confirmed ban blocks at or above mainnet height 144888, within the requested retention window.', schema: { type: 'string', enum: ['rolling', 'q60'], default: 'rolling' } },
          { name: 'hours', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 2160, default: 168 } },
          { name: 'windowMinutes', in: 'query', schema: { type: 'integer', minimum: 5, maximum: 120, default: 30 } },
          { name: 'minNodes', in: 'query', schema: { type: 'integer', minimum: 2, maximum: 50, default: 3 } },
          { name: 'bucket', in: 'query', schema: { type: 'string', enum: ['auto', '15min', 'hour', 'day'], default: 'auto' } },
        ],
        responses: {
          200: openApiSuccessResponse('BanWaveAnalysisApiResponse'),
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/meta': {
      get: {
        tags: ['V1'],
        summary: 'Versioned API metadata',
        responses: {
          200: OpenApiResponses.ok,
        },
      },
    },
    '/api/v1/network/health': {
      get: {
        tags: ['V1'],
        summary: 'Versioned network health snapshot',
        responses: {
          200: OpenApiResponses.ok,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/network/sporks': {
      get: {
        tags: ['V1'],
        summary: 'Versioned spork and governance status snapshot',
        responses: {
          200: OpenApiResponses.ok,
          503: OpenApiResponses.serviceUnavailable,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/network/governance/objects': {
      get: {
        tags: ['V1'],
        summary: 'Versioned governance object listing (read-only)',
        parameters: [
          { $ref: '#/components/parameters/GovernanceSignal' },
          { $ref: '#/components/parameters/GovernanceObjectType' },
          { $ref: '#/components/parameters/GovernanceObjectsLimit' },
          { $ref: '#/components/parameters/GovernanceIncludeRaw' },
        ],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          503: OpenApiResponses.serviceUnavailable,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/rewards/current': {
      get: {
        tags: ['V1'],
        summary: 'Versioned reward split snapshot',
        responses: {
          200: OpenApiResponses.ok,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/blocks/latest': {
      get: {
        tags: ['V1'],
        summary: 'Versioned latest blocks with reward split',
        parameters: [{ $ref: '#/components/parameters/Count' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/txs/latest': {
      get: {
        tags: ['V1'],
        summary: 'Versioned latest transactions with tx classification',
        parameters: [{ $ref: '#/components/parameters/Count' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/address/{address}/rewards': {
      get: {
        tags: ['V1'],
        summary: 'Address reward aggregates (coinbase + stake)',
        description:
          'coinbase*: block reward transactions that pay the address (in proof-of-stake blocks, its masternode payments). ' +
          'stake*: transactions in which the address staked; stakeTotal is the net stake reward in DFCN, ' +
          'what came back to the address minus what it staked. A stake whose amounts are not all stored ' +
          'is counted in stakeTxCount but adds nothing to stakeTotal.',
        parameters: [{ $ref: '#/components/parameters/Address' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/masternodes/{id}': {
      get: {
        tags: ['V1'],
        summary: 'Masternode detail by id or proTxHash',
        parameters: [{ $ref: '#/components/parameters/MasternodeId' }],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          404: OpenApiResponses.notFound,
          500: OpenApiResponses.internalError,
          503: OpenApiResponses.serviceUnavailable,
        },
      },
    },
    '/api/v1/masternodes/{id}/events': {
      get: {
        tags: ['V1'],
        summary: 'Masternode events',
        parameters: [
          { $ref: '#/components/parameters/MasternodeId' },
          { $ref: '#/components/parameters/EventsLimit' },
        ],
        responses: {
          200: OpenApiResponses.ok,
          400: OpenApiResponses.badRequest,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/masternodes/bans/export': {
      get: {
        tags: ['V1', 'Masternodes'],
        summary: 'Bulk PoSe ban / recovery dataset export',
        description:
          'Full PoSe ban / recovery dataset as a single download for offline / AI-assisted analysis. Read-only public data.',
        parameters: [
          { name: 'format', in: 'query', description: 'Output format', schema: { type: 'string', enum: ['ndjson', 'csv', 'json'], default: 'ndjson' } },
          { name: 'type', in: 'query', description: 'Event type filter', schema: { type: 'string', enum: ['all', 'ban', 'recovery'], default: 'all' } },
          { name: 'since', in: 'query', description: 'Minimum poseBanHeight (inclusive)', schema: { type: 'integer', minimum: 0 } },
        ],
        responses: {
          200: OpenApiResponses.ok,
          500: OpenApiResponses.internalError,
        },
      },
    },
    '/api/v1/masternodes/bans/schema': {
      get: {
        tags: ['V1', 'Masternodes'],
        summary: 'Ban export field dictionary',
        description: 'Field descriptions for the ban export, so AI tools can interpret each column.',
        responses: {
          200: OpenApiResponses.ok,
        },
      },
    },
    '/api/v1/masternodes/bans/stats': {
      get: {
        tags: ['V1', 'Masternodes'],
        summary: 'Pre-aggregated PoSe ban analytics',
        description:
          'Top providers, countries, payout-operator clusters and largest exact-height ban waves. For AI/MCP summaries without raw rows.',
        parameters: [
          { name: 'since', in: 'query', description: 'Minimum poseBanHeight (inclusive)', schema: { type: 'integer', minimum: 0 } },
        ],
        responses: {
          200: OpenApiResponses.ok,
          500: OpenApiResponses.internalError,
        },
      },
    },
  },
  components: {
    parameters: {
      Page: {
        name: 'page',
        in: 'query',
        description: 'Page number (1-based)',
        schema: { type: 'integer', minimum: 1, default: 1 },
      },
      Limit: {
        name: 'limit',
        in: 'query',
        description: 'Page size',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      Count: {
        name: 'count',
        in: 'query',
        description: 'Number of latest items',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
      },
      RichListLimit: {
        name: 'limit',
        in: 'query',
        description: 'Page size for rich list',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
      },
      MempoolLimit: {
        name: 'limit',
        in: 'query',
        description: 'Number of sampled mempool transactions',
        schema: { type: 'integer', minimum: 1, maximum: 30, default: 20 },
      },
      MarketDays: {
        name: 'days',
        in: 'query',
        description: 'History window in days',
        schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
      },
      GovernanceSignal: {
        name: 'signal',
        in: 'query',
        description: 'Governance list signal filter',
        schema: { type: 'string', enum: ['all', 'valid', 'funding', 'delete', 'endorsed'], default: 'valid' },
      },
      GovernanceObjectType: {
        name: 'objectType',
        in: 'query',
        description: 'Governance object type filter',
        schema: { type: 'string', enum: ['all', 'proposals', 'triggers'], default: 'all' },
      },
      GovernanceObjectsLimit: {
        name: 'limit',
        in: 'query',
        description: 'Maximum governance objects returned',
        schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
      GovernanceIncludeRaw: {
        name: 'includeRaw',
        in: 'query',
        description: 'Include raw daemon payload for each governance object',
        schema: { type: 'boolean', default: false },
      },
      EventsLimit: {
        name: 'limit',
        in: 'query',
        description: 'Maximum number of events',
        schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
      FromTimestamp: {
        name: 'from',
        in: 'query',
        description: 'Unix timestamp lower bound',
        schema: { type: 'integer', minimum: 0 },
      },
      ToTimestamp: {
        name: 'to',
        in: 'query',
        description: 'Unix timestamp upper bound',
        schema: { type: 'integer', minimum: 0 },
      },
      SearchQuery: {
        name: 'q',
        in: 'query',
        required: true,
        description: 'Search token (height/hash/txid/address)',
        schema: { type: 'string', minLength: 1, maxLength: 128 },
      },
      HashOrHeight: {
        name: 'hashOrHeight',
        in: 'path',
        required: true,
        description: 'Block hash (64 hex) or block height',
        schema: { type: 'string' },
      },
      Txid: {
        name: 'txid',
        in: 'path',
        required: true,
        description: 'Transaction ID',
        schema: { type: 'string', minLength: 64, maxLength: 64 },
      },
      Address: {
        name: 'address',
        in: 'path',
        required: true,
        description: 'Base58 chain address',
        schema: { type: 'string', minLength: 26, maxLength: 35 },
      },
      MasternodeId: {
        name: 'id',
        in: 'path',
        required: true,
        description: 'Masternode id or proTxHash',
        schema: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    schemas: {
      ...openApiContractSchemas,
      ApiSuccess: {
        type: 'object',
        required: ['success', 'data'],
        properties: {
          success: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            additionalProperties: true,
          },
          pagination: {
            $ref: '#/components/schemas/Pagination',
          },
          filters: {
            type: 'object',
            additionalProperties: true,
          },
          meta: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
      ApiError: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
      Pagination: {
        type: 'object',
        required: ['page', 'limit', 'total', 'pages'],
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          pages: { type: 'integer' },
        },
      },
    },
    responses: {
      Ok: OpenApiResponses.ok,
      BadRequest: OpenApiResponses.badRequest,
      NotFound: OpenApiResponses.notFound,
      ServiceUnavailable: OpenApiResponses.serviceUnavailable,
      InternalError: OpenApiResponses.internalError,
    },
  },
};
