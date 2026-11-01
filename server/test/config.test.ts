import { ConfigurationError, loadConfig } from '../src/config';

describe('server configuration', () => {
  it('returns typed development defaults from an empty environment', () => {
    const parsed = loadConfig({});

    expect(parsed.nodeEnv).toBe('development');
    expect(parsed.port).toBe(3001);
    expect(parsed.rpc.port).toBe(8193);
    expect(parsed.nodeInventory.requestTimeoutMs).toBe(6000);
    expect(parsed.nodeInventory.failureBackoffMs).toBe(30000);
    expect(parsed.nodeInventory.minimumRecommendedVersion).toBe('23.0.0');
    expect(parsed.migration.extraHotWalletAddresses).toEqual([]);
    expect(parsed.publicSiteUrl).toBe('https://deftrack.xyz');
  });

  it('leaves the external node feeds disabled unless their URLs are configured', () => {
    const disabled = loadConfig({});
    expect(disabled.nodeInventory.dnsSeederApiUrl).toBe('');
    expect(disabled.nodeInventory.preReleaseNodesApiUrl).toBe('');
    expect(disabled.nodeInventory.preReleaseNodesApiKey).toBe('');

    const blank = loadConfig({ DNS_SEEDER_API_URL: '  ', PRE_RELEASE_NODES_API_URL: '' });
    expect(blank.nodeInventory.dnsSeederApiUrl).toBe('');
    expect(blank.nodeInventory.preReleaseNodesApiUrl).toBe('');

    const configured = loadConfig({
      DNS_SEEDER_API_URL: 'https://seeder.example.com/nodes/',
      PRE_RELEASE_NODES_API_URL: ' https://seeder.example.com/fullnodes ',
      PRE_RELEASE_NODES_API_KEY: ' feed-key ',
    });
    expect(configured.nodeInventory.dnsSeederApiUrl).toBe('https://seeder.example.com/nodes');
    expect(configured.nodeInventory.preReleaseNodesApiUrl).toBe('https://seeder.example.com/fullnodes');
    expect(configured.nodeInventory.preReleaseNodesApiKey).toBe('feed-key');

    expect(() => loadConfig({ PRE_RELEASE_NODES_API_URL: 'ftp://seeder.example.com/fullnodes' })).toThrow(
      /PRE_RELEASE_NODES_API_URL must use one of: http:, https:/
    );
  });

  it('leaves the Telegram host commands disabled unless configured', () => {
    const disabled = loadConfig({});
    expect(disabled.telegram.reindexCommand).toBe('');
    expect(disabled.telegram.daemonStatusCommand).toBe('');

    const configured = loadConfig({
      TELEGRAM_REINDEX_COMMAND: ' /usr/local/bin/reindex-daemon ',
      TELEGRAM_DAEMON_STATUS_COMMAND: '/usr/local/bin/daemon-status',
    });
    expect(configured.telegram.reindexCommand).toBe('/usr/local/bin/reindex-daemon');
    expect(configured.telegram.daemonStatusCommand).toBe('/usr/local/bin/daemon-status');
  });

  it('normalizes lists, booleans, numbers, URLs, and secrets once', () => {
    const token = 'a'.repeat(32);
    const parsed = loadConfig({
      NODE_ENV: 'test',
      PORT: '4100',
      ALLOW_DB_WIPE: 'yes',
      CORS_ORIGINS: 'https://one.example, https://two.example ',
      VITE_PUBLIC_SITE_URL: 'https://example.test/',
      MIGRATION_HOT_WALLET_ADDRESSES: 'D1, D2, D1',
      NETWORK_NOISE_MONITOR_ENABLED: 'true',
      NETWORK_NOISE_INGEST_TOKENS: `node-a=${token}`,
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_ADMIN_ID: '42',
    });

    expect(parsed.port).toBe(4100);
    expect(parsed.sync.allowDbWipe).toBe(true);
    expect(parsed.cors.origins).toEqual(['https://one.example', 'https://two.example']);
    expect(parsed.publicSiteUrl).toBe('https://example.test');
    expect(parsed.migration.extraHotWalletAddresses).toEqual(['D1', 'D2', 'D1']);
    expect(parsed.networkNoise.ingestTokens).toEqual({ 'node-a': token });
    expect(parsed.telegram.adminId).toBe(42);
  });

  it('rejects malformed values instead of silently using defaults', () => {
    expect(() =>
      loadConfig({
        PORT: 'not-a-number',
        SYNC_INTERVAL_MS: '99',
        IP_API_ENABLED: 'sometimes',
        DNS_SEEDER_API_URL: 'not-a-url',
      })
    ).toThrowError(ConfigurationError);

    try {
      loadConfig({ PORT: 'not-a-number', DNS_SEEDER_API_URL: 'not-a-url' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues).toEqual(
        expect.arrayContaining([
          'PORT must be an integer.',
          'DNS_SEEDER_API_URL must be a valid absolute URL.',
        ])
      );
    }
  });

  it('fails fast when production RPC credentials are missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      /RPC_PASS is required in production/
    );
    expect(() => loadConfig({ NODE_ENV: 'production', RPC_PASS: 'rpc-secret' })).not.toThrow();
  });

  it('requires the monitored test node API key in production only when its feed is enabled', () => {
    const feedUrl = 'https://seeder.example.com/fullnodes';

    expect(() =>
      loadConfig({ NODE_ENV: 'production', RPC_PASS: 'rpc-secret', PRE_RELEASE_NODES_API_URL: feedUrl })
    ).toThrow(/PRE_RELEASE_NODES_API_KEY is required in production when PRE_RELEASE_NODES_API_URL is set/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        RPC_PASS: 'rpc-secret',
        PRE_RELEASE_NODES_API_URL: feedUrl,
        PRE_RELEASE_NODES_API_KEY: 'monitor-secret',
      })
    ).not.toThrow();
    // Outside production the key stays optional even when the feed is enabled.
    expect(() => loadConfig({ PRE_RELEASE_NODES_API_URL: feedUrl })).not.toThrow();
  });

  it('requires paired integration credentials', () => {
    expect(() => loadConfig({ IP_API_HTTPS: 'true' })).toThrow(
      /IP_API_KEY is required when IP_API_HTTPS is enabled/
    );
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: 'token' })).toThrow(
      /TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_ID must be configured together/
    );
  });

  it('rejects an enabled noise monitor without valid ingest tokens', () => {
    expect(() =>
      loadConfig({
        NETWORK_NOISE_MONITOR_ENABLED: 'true',
        NETWORK_NOISE_INGEST_TOKENS: 'node-a=short',
      })
    ).toThrow(/NETWORK_NOISE_INGEST_TOKENS/);
  });

  it('rejects weak configured admin credentials', () => {
    expect(() => loadConfig({ ADMIN_API_KEY: 'short' })).toThrow(
      /ADMIN_API_KEY must contain at least 32 characters/
    );
  });

  it('retains structured PoSe observations independently of legacy noise', () => {
    expect(loadConfig({}).networkNoise.poseObservationTtlDays).toBe(365);
    const parsed = loadConfig({ POSE_OBSERVATION_TTL_DAYS: '730', NETWORK_NOISE_OBSERVATION_TTL_DAYS: '7' });
    expect(parsed.networkNoise.poseObservationTtlDays).toBe(730);
    expect(parsed.networkNoise.observationTtlDays).toBe(7);
    expect(() => loadConfig({ POSE_OBSERVATION_TTL_DAYS: '0' })).toThrow(/POSE_OBSERVATION_TTL_DAYS/);
    expect(() => loadConfig({ POSE_OBSERVATION_TTL_DAYS: '1826' })).toThrow(/POSE_OBSERVATION_TTL_DAYS/);
  });

  it('bounds batch receipt retention', () => {
    expect(loadConfig({}).networkNoise.receiptRetentionDays).toBe(30);
    expect(loadConfig({ NETWORK_NOISE_RECEIPT_RETENTION_DAYS: '90' }).networkNoise.receiptRetentionDays).toBe(90);
    expect(() => loadConfig({ NETWORK_NOISE_RECEIPT_RETENTION_DAYS: '0' })).toThrow(/NETWORK_NOISE_RECEIPT_RETENTION_DAYS/);
    expect(() => loadConfig({ NETWORK_NOISE_RECEIPT_RETENTION_DAYS: '1826' })).toThrow(/NETWORK_NOISE_RECEIPT_RETENTION_DAYS/);
  });

  it('leaves canonical collection opt-in and bounds its RPC and reorg budgets', () => {
    expect(loadConfig({}).poseChain).toEqual({ enabled: false, startHeight: 144888, blocksPerRun: 50,
      confirmations: 3, intervalMs: 30000, reorgMaxDepth: 128, membershipRetryBlocks: 5,
      attributionEnabled: false, attributionBlocksPerRun: 5 });
    expect(loadConfig({ POSE_CHAIN_COLLECTOR_ENABLED: 'true', POSE_CHAIN_MEMBERSHIP_RETRY_BLOCKS: '0' }).poseChain)
      .toMatchObject({ enabled: true, membershipRetryBlocks: 0 });
    for (const [key, value] of Object.entries({ POSE_CHAIN_START_HEIGHT: '0', POSE_CHAIN_BLOCKS_PER_RUN: '201',
      POSE_CHAIN_CONFIRMATIONS: '0', POSE_CHAIN_POLL_INTERVAL_MS: '9999', POSE_CHAIN_REORG_MAX_DEPTH: '0',
      POSE_CHAIN_MEMBERSHIP_RETRY_BLOCKS: '21', POSE_CHAIN_ATTRIBUTION_BLOCKS_PER_RUN: '0' })) {
      expect(() => loadConfig({ [key]: value })).toThrow(key);
    }
  });
});
