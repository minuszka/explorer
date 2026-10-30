import dotenv from 'dotenv';
import path from 'path';
import { COIN, DEFAULT_SITE_URL } from '@defcon/shared';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

type Environment = Readonly<Record<string, string | undefined>>;
type TrustProxySetting = boolean | number | string;
type MarketSource = 'coingecko' | 'qutrade';
type NodeEnvironment = 'development' | 'test' | 'production';

const ADMIN_API_KEY_MIN_LENGTH = 32;

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid server configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

function parseCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSecretMap(value?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of parseCsv(value)) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    const secret = entry.slice(separator + 1).trim();
    if (!key || secret.length < 32) continue;
    result[key] = secret;
  }
  return result;
}

function parseIntEnv(
  env: Environment,
  name: string,
  fallback: number,
  issues: string[],
  bounds?: { min?: number; max?: number }
): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return fallback;

  if (!/^-?\d+$/.test(raw.trim())) {
    issues.push(`${name} must be an integer.`);
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    issues.push(`${name} must be a safe integer.`);
    return fallback;
  }
  if (typeof bounds?.min === 'number' && parsed < bounds.min) {
    issues.push(`${name} must be at least ${bounds.min}.`);
  }
  if (typeof bounds?.max === 'number' && parsed > bounds.max) {
    issues.push(`${name} must be at most ${bounds.max}.`);
  }
  return parsed;
}

function parseOptionalIntEnv(
  env: Environment,
  name: string,
  issues: string[],
  bounds?: { min?: number; max?: number }
): number | null {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return null;
  return parseIntEnv(env, name, 0, issues, bounds);
}

function parseBoolEnv(
  env: Environment,
  name: string,
  fallback: boolean,
  issues: string[]
): boolean {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  issues.push(`${name} must be a boolean (true/false, yes/no, on/off, or 1/0).`);
  return fallback;
}

function parseTrimmedEnv(env: Environment, name: string, fallback: string): string {
  const trimmed = String(env[name] || '').trim();
  return trimmed || fallback;
}

function parseUrlEnv(
  env: Environment,
  name: string,
  fallback: string,
  issues: string[],
  protocols: readonly string[] = ['http:', 'https:']
): string {
  const value = parseTrimmedEnv(env, name, fallback).replace(/\/+$/, '');
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) {
      issues.push(`${name} must use one of: ${protocols.join(', ')}`);
    }
  } catch {
    issues.push(`${name} must be a valid absolute URL.`);
  }
  return value;
}

// Optional integration endpoint without a built-in default: an empty or unset
// value disables the feature, any other value must be a valid URL.
function parseOptionalUrlEnv(env: Environment, name: string, issues: string[]): string {
  if (!String(env[name] || '').trim()) return '';
  return parseUrlEnv(env, name, '', issues);
}

function parseNodeEnvironment(value: string | undefined, issues: string[]): NodeEnvironment {
  const normalized = String(value || 'development').trim().toLowerCase();
  if (normalized === 'development' || normalized === 'test' || normalized === 'production') {
    return normalized;
  }
  issues.push('NODE_ENV must be development, test, or production.');
  return 'development';
}

function parseMarketSource(value: string | undefined, issues: string[]): MarketSource {
  const normalized = String(value || 'qutrade').trim().toLowerCase();
  if (normalized === 'qutrade' || normalized === 'coingecko') return normalized;
  issues.push('MARKET_SOURCE must be qutrade or coingecko.');
  return 'qutrade';
}

function parseTrustProxyEnv(value: string | undefined): TrustProxySetting {
  if (value == null || value.trim() === '') return 1;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);

  const normalized = trimmed.toLowerCase();
  if (['true', 'yes', 'on'].includes(normalized)) return true;
  if (['false', 'no', 'off'].includes(normalized)) return false;
  return trimmed;
}

function parseAdminApiKey(value: string | undefined, issues: string[]): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (trimmed.length < ADMIN_API_KEY_MIN_LENGTH) {
    issues.push(`ADMIN_API_KEY must contain at least ${ADMIN_API_KEY_MIN_LENGTH} characters.`);
  }
  return trimmed;
}

function requireProductionValue(
  nodeEnv: NodeEnvironment,
  name: string,
  value: string,
  issues: string[]
): void {
  if (nodeEnv === 'production' && !value.trim()) {
    issues.push(`${name} is required in production.`);
  }
}

export function loadConfig(env: Environment = process.env) {
  const issues: string[] = [];
  const nodeEnv = parseNodeEnvironment(env.NODE_ENV, issues);
  const rpcPass = String(env.RPC_PASS || '').trim();
  const dnsSeederApiUrl = parseOptionalUrlEnv(env, 'DNS_SEEDER_API_URL', issues);
  const preReleaseNodesApiUrl = parseOptionalUrlEnv(env, 'PRE_RELEASE_NODES_API_URL', issues);
  const preReleaseNodesApiKey = String(env.PRE_RELEASE_NODES_API_KEY || '').trim();
  const networkNoiseEnabled = parseBoolEnv(
    env,
    'NETWORK_NOISE_MONITOR_ENABLED',
    false,
    issues
  );
  const networkNoiseTokens = parseSecretMap(env.NETWORK_NOISE_INGEST_TOKENS);
  const ipApiUseHttps = parseBoolEnv(env, 'IP_API_HTTPS', false, issues);
  const ipApiKey = String(env.IP_API_KEY || '').trim();
  const telegramBotToken = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const telegramAdminId = parseIntEnv(env, 'TELEGRAM_ADMIN_ID', 0, issues, { min: 0 });

  const mongodbUri = parseTrimmedEnv(
    env,
    'MONGODB_URI',
    'mongodb://localhost:27017/defcon_explorer'
  );
  if (!/^mongodb(?:\+srv)?:\/\//i.test(mongodbUri)) {
    issues.push('MONGODB_URI must use mongodb:// or mongodb+srv://.');
  }

  requireProductionValue(nodeEnv, 'RPC_PASS', rpcPass, issues);
  if (nodeEnv === 'production' && preReleaseNodesApiUrl && !preReleaseNodesApiKey) {
    issues.push(
      'PRE_RELEASE_NODES_API_KEY is required in production when PRE_RELEASE_NODES_API_URL is set.'
    );
  }
  if (networkNoiseEnabled && Object.keys(networkNoiseTokens).length === 0) {
    issues.push(
      'NETWORK_NOISE_INGEST_TOKENS must contain at least one node=token entry when the monitor is enabled.'
    );
  }
  if (ipApiUseHttps && !ipApiKey) {
    issues.push('IP_API_KEY is required when IP_API_HTTPS is enabled.');
  }
  if ((telegramBotToken && telegramAdminId === 0) || (!telegramBotToken && telegramAdminId > 0)) {
    issues.push('TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_ID must be configured together.');
  }

  const qutradePairUsdt = parseTrimmedEnv(env, 'QUTRADE_PAIR_USDT', 'dfcn_usdt').toLowerCase();

  const parsed = {
    nodeEnv,
    port: parseIntEnv(env, 'PORT', 3001, issues, { min: 1, max: 65535 }),
    publicSiteUrl: parseUrlEnv(env, 'VITE_PUBLIC_SITE_URL', DEFAULT_SITE_URL, issues),

    mongodb: {
      uri: mongodbUri,
    },

    rpc: {
      host: parseTrimmedEnv(env, 'RPC_HOST', '127.0.0.1'),
      port: parseIntEnv(env, 'RPC_PORT', COIN.DEFAULT_RPC_PORT, issues, {
        min: 1,
        max: 65535,
      }),
      user: parseTrimmedEnv(env, 'RPC_USER', 'defconrpc'),
      pass: rpcPass,
      timeout: parseIntEnv(env, 'RPC_TIMEOUT', 30000, issues, { min: 1000 }),
    },

    cors: {
      origins: parseCsv(env.CORS_ORIGINS),
    },

    http: {
      trustProxy: parseTrustProxyEnv(env.TRUST_PROXY),
    },

    rateLimit: {
      maxRequestsPerMinute: parseIntEnv(
        env,
        'RATE_LIMIT_MAX_PER_MINUTE',
        1200,
        issues,
        { min: 1 }
      ),
      ipHeaders: parseCsv(env.RATE_LIMIT_IP_HEADERS || 'cf-connecting-ip,x-real-ip').map(
        (header) => header.toLowerCase()
      ),
    },

    address: {
      p2pkhVersionByte: parseOptionalIntEnv(env, 'P2PKH_VERSION', issues, {
        min: 0,
        max: 255,
      }),
    },

    sync: {
      intervalMs: parseIntEnv(env, 'SYNC_INTERVAL_MS', 10000, issues, { min: 1000 }),
      reorgMaxDepth: parseIntEnv(env, 'REORG_MAX_DEPTH', 2000, issues, { min: 1 }),
      allowDbWipe: parseBoolEnv(env, 'ALLOW_DB_WIPE', false, issues),
      maxAutoWipeDocs: parseIntEnv(env, 'AUTO_WIPE_MAX_DOCS', 500000, issues, { min: 1 }),
    },

    cache: {
      ttlSeconds: parseIntEnv(env, 'CACHE_TTL_SECONDS', 10, issues, { min: 0 }),
    },

    masternode: {
      pollIntervalMs: parseIntEnv(env, 'MN_POLL_INTERVAL_MS', 300000, issues, {
        min: 60000,
      }),
    },

    nodeInventory: {
      pollIntervalMs: parseIntEnv(
        env,
        'NODE_INVENTORY_POLL_INTERVAL_MS',
        300000,
        issues,
        { min: 60000 }
      ),
      minimumRecommendedVersion: parseTrimmedEnv(
        env,
        'NODE_INVENTORY_MIN_VERSION',
        '23.0.0'
      ),
      // Empty string = feed disabled.
      dnsSeederApiUrl,
      preReleaseNodesApiUrl,
      preReleaseNodesApiKey,
      requestTimeoutMs: parseIntEnv(
        env,
        'NODE_INVENTORY_REQUEST_TIMEOUT_MS',
        6000,
        issues,
        { min: 500, max: 30000 }
      ),
      failureBackoffMs: parseIntEnv(
        env,
        'NODE_INVENTORY_FAILURE_BACKOFF_MS',
        30000,
        issues,
        { min: 1000, max: 3600000 }
      ),
      staleMaxAgeMs: parseIntEnv(
        env,
        'NODE_INVENTORY_STALE_MAX_AGE_MS',
        600000,
        issues,
        { min: 10000, max: 86400000 }
      ),
    },

    poseChain: {
      enabled: parseBoolEnv(env, 'POSE_CHAIN_COLLECTOR_ENABLED', false, issues),
      startHeight: parseIntEnv(env, 'POSE_CHAIN_START_HEIGHT', 144888, issues, { min: 1 }),
      blocksPerRun: parseIntEnv(env, 'POSE_CHAIN_BLOCKS_PER_RUN', 50, issues, { min: 1, max: 200 }),
      confirmations: parseIntEnv(env, 'POSE_CHAIN_CONFIRMATIONS', 3, issues, { min: 1, max: 100 }),
      intervalMs: parseIntEnv(env, 'POSE_CHAIN_POLL_INTERVAL_MS', 30000, issues, { min: 10000, max: 3600000 }),
      reorgMaxDepth: parseIntEnv(env, 'POSE_CHAIN_REORG_MAX_DEPTH', 128, issues, { min: 1, max: 10000 }),
      membershipRetryBlocks: parseIntEnv(env, 'POSE_CHAIN_MEMBERSHIP_RETRY_BLOCKS', 5, issues, { min: 0, max: 20 }),
      attributionEnabled: parseBoolEnv(env, 'POSE_CHAIN_ATTRIBUTION_ENABLED', false, issues),
      attributionBlocksPerRun: parseIntEnv(env, 'POSE_CHAIN_ATTRIBUTION_BLOCKS_PER_RUN', 5, issues, { min: 1, max: 20 }),
    },

    networkNoise: {
      enabled: networkNoiseEnabled,
      ingestTokens: networkNoiseTokens,
      observationTtlDays: parseIntEnv(
        env,
        'NETWORK_NOISE_OBSERVATION_TTL_DAYS',
        30,
        issues,
        { min: 1, max: 365 }
      ),
      staleAfterMs: parseIntEnv(env, 'NETWORK_NOISE_STALE_AFTER_MS', 180000, issues, {
        min: 60000,
        max: 3600000,
      }),
      // Allowance for an agent clock running ahead of the server's first receipt.
      clockSkewMs: parseIntEnv(env, 'NETWORK_NOISE_CLOCK_SKEW_MS', 5000, issues, {
        min: 0,
        max: 60000,
      }),
      poseObservationTtlDays: parseIntEnv(env, 'POSE_OBSERVATION_TTL_DAYS', 365, issues, {
        min: 1,
        max: 1825,
      }),
    },

    providerLookup: {
      geoipAsnMmdbPath: parseTrimmedEnv(env, 'GEOIP_ASN_MMDB', ''),
      ipApiEnabled: parseBoolEnv(env, 'IP_API_ENABLED', true, issues),
      ipApiUseHttps,
      ipApiKey,
      ipApiBatchTimeoutMs: parseIntEnv(env, 'IP_API_BATCH_TIMEOUT_MS', 4000, issues, {
        min: 500,
        max: 30000,
      }),
      ipApiMaxBatchPerCycle: parseIntEnv(
        env,
        'IP_API_MAX_BATCH_PER_CYCLE',
        3,
        issues,
        { min: 0, max: 50 }
      ),
    },

    market: {
      source: parseMarketSource(env.MARKET_SOURCE, issues),
      coingeckoId: String(env.COINGECKO_ID || '').trim(),
      qutradeApiBaseUrl: parseUrlEnv(
        env,
        'QUTRADE_API_BASE_URL',
        'https://qutrade.io/api/v1',
        issues
      ),
      qutradePairUsdt,
      qutradePairBtc: parseTrimmedEnv(env, 'QUTRADE_PAIR_BTC', 'dfcn_btc').toLowerCase(),
      qutradeHistoryPair: parseTrimmedEnv(
        env,
        'QUTRADE_HISTORY_PAIR',
        qutradePairUsdt
      ).toLowerCase(),
      qutradeTradesLimit: parseIntEnv(env, 'QUTRADE_TRADES_LIMIT', 100, issues, {
        min: 1,
        max: 100,
      }),
    },

    migration: {
      hotWalletAddress: parseTrimmedEnv(
        env,
        'MIGRATION_HOT_WALLET_ADDRESS',
        'D91nHyL8FSYWZHBVTnctnzvhC3QvynghCR'
      ),
      extraHotWalletAddresses: parseCsv(env.MIGRATION_HOT_WALLET_ADDRESSES),
    },

    admin: {
      apiKey: parseAdminApiKey(env.ADMIN_API_KEY, issues),
    },

    telegram: {
      botToken: telegramBotToken,
      adminId: telegramAdminId,
      // Host-specific shell commands for /reindex and /daemonstatus.
      // Empty = the command is disabled.
      reindexCommand: String(env.TELEGRAM_REINDEX_COMMAND || '').trim(),
      daemonStatusCommand: String(env.TELEGRAM_DAEMON_STATUS_COMMAND || '').trim(),
    },
  };

  if (issues.length > 0) throw new ConfigurationError(issues);
  return parsed;
}

export type AppConfig = ReturnType<typeof loadConfig>;

// Parse and validate exactly once. Other server modules must consume this
// object instead of reading process.env directly.
export const config: AppConfig = loadConfig(process.env);
