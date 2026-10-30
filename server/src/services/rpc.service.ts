import axios, { AxiosInstance } from 'axios';
import http from 'node:http';
import https from 'node:https';
import { config } from '../config';
import { logger } from '../utils/logger';

// Per-method cache TTL (ms). Methods absent here are never cached.
// Tuned for typical block time (~2 min). Cache is short enough that staleness
// is negligible, long enough to absorb bursts from the dashboard polling cycle.
const CACHE_TTL_MS: Record<string, number> = {
  getblockcount: 3_000,
  getblockchaininfo: 5_000,
  getnetworkinfo: 5_000,
  getmempoolinfo: 3_000,
  getdifficulty: 10_000,
  getmininginfo: 5_000,
  getnetworkhashps: 15_000,
  getpeerinfo: 5_000,
  getrawmempool: 2_000,
};

type CacheEntry = { value: unknown; atMs: number };

class RpcService {
  private client: AxiosInstance;
  private requestId = 0;
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<unknown>>();

  constructor() {
    const withTrailingSlash = (value: string): string =>
      value.endsWith('/') ? value : `${value}/`;

    // Support both full URL (http://host/path) and hostname
    let baseURL: string;
    if (config.rpc.host.startsWith('http://') || config.rpc.host.startsWith('https://')) {
      // Full URL provided (e.g., http://your-daemon-host/rpc)
      baseURL = withTrailingSlash(config.rpc.host.trim());
    } else {
      // Legacy hostname:port format
      baseURL = withTrailingSlash(`http://${config.rpc.host}:${config.rpc.port}`);
    }

    this.client = axios.create({
      baseURL,
      auth: {
        username: config.rpc.user,
        password: config.rpc.pass,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: config.rpc.timeout,
      // Keep-alive avoids fd-exhaustion under bursty load: every dashboard
      // request can fan out 4-6 RPC calls; without pooling each opens a new
      // TCP connection. maxSockets caps concurrent in-flight requests.
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 32 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 32 }),
      maxRedirects: 0,
    });

    // Defense-in-depth: scrub the Authorization header (and the `auth` field)
    // from any error object before it bubbles up to a logger that might
    // serialize the full axios config. Without this, a stray `logger.error(err)`
    // anywhere in the call stack could leak base64(user:pass).
    if (this.client.interceptors?.response?.use) {
      this.client.interceptors.response.use(undefined, (error: unknown) => {
        const cfg = (error as { config?: { headers?: Record<string, unknown>; auth?: unknown } })?.config;
        if (cfg) {
          if (cfg.headers && typeof cfg.headers === 'object') {
            if ('Authorization' in cfg.headers) cfg.headers.Authorization = '***';
            if ('authorization' in cfg.headers) cfg.headers.authorization = '***';
          }
          if (cfg.auth) cfg.auth = { username: '***', password: '***' };
        }
        const reqHeaders = (error as { request?: { _header?: string } })?.request?._header;
        if (typeof reqHeaders === 'string') {
          (error as { request: { _header: string } }).request._header = reqHeaders.replace(
            /Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi,
            'Authorization: Basic ***'
          );
        }
        return Promise.reject(error);
      });
    }
  }

  /** `fresh` skips the cache and any in-flight request, for answers that must belong to this moment. */
  async call<T = unknown>(method: string, params: unknown[] = [], options: { fresh?: boolean } = {}): Promise<T> {
    const ttl = CACHE_TTL_MS[method.toLowerCase()];
    // Only cache parameterless lookups; parameterized calls (getblock, getrawtransaction…)
    // are content-addressable and managed elsewhere.
    const cacheable = !options.fresh && ttl != null && params.length === 0;
    const cacheKey = cacheable ? method.toLowerCase() : null;

    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.atMs < ttl) {
        return cached.value as T;
      }
      const pending = this.inFlight.get(cacheKey);
      if (pending) {
        return pending as Promise<T>;
      }
    }

    const promise = this.doCall<T>(method, params);

    if (cacheKey) {
      this.inFlight.set(cacheKey, promise as Promise<unknown>);
      promise
        .then((value) => {
          this.cache.set(cacheKey, { value, atMs: Date.now() });
        })
        .catch(() => {
          // Don't poison the cache on errors; let the next call retry.
        })
        .finally(() => {
          this.inFlight.delete(cacheKey);
        });
    }

    return promise;
  }

  private async doCall<T>(method: string, params: unknown[]): Promise<T> {
    const id = ++this.requestId;
    try {
      // Keep relative empty path so baseURL path segments are preserved.
      // baseURL always has a trailing slash, so "/rpc/" style endpoints work.
      const response = await this.client.post('', {
        jsonrpc: '1.0',
        id,
        method,
        params,
      });

      const data = response.data;

      // Validate RPC-level error (daemon returned HTTP 200 but with an error payload)
      if (data?.error) {
        const rpcErr = typeof data.error === 'object' ? data.error.message : data.error;
        throw new Error(`RPC ${method}: ${rpcErr || 'Unknown RPC error'}`);
      }

      if (!data || !('result' in data)) {
        throw new Error(`RPC ${method}: response missing 'result' field`);
      }

      return data.result as T;
    } catch (error: unknown) {
      // Re-throw our own errors as-is
      if (error instanceof Error && error.message.startsWith(`RPC ${method}:`)) {
        logger.error(error.message);
        throw error;
      }

      const status = (error as { response?: { status?: number } })?.response?.status;
      const errData = (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error;
      let rawMessage =
        errData?.message ||
        (error instanceof Error ? error.message : undefined) ||
        (typeof status === 'number' ? `HTTP ${status}` : undefined) ||
        'Connection failed';

      // Sanitize: strip potential credentials/auth info from error messages
      rawMessage = rawMessage
        .replace(/\/\/[^@/]+:[^@/]+@/g, '//***:***@')
        .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***');

      logger.error(`RPC ${method} failed: ${rawMessage}`);
      throw new Error(`RPC ${method}: ${rawMessage}`);
    }
  }

  async getBlockCount(): Promise<number> {
    return this.call<number>('getblockcount');
  }

  async getBlockHash(height: number): Promise<string> {
    return this.call<string>('getblockhash', [height]);
  }

  async getBlock(hash: string, verbosity = 2): Promise<unknown> {
    return this.call('getblock', [hash, verbosity]);
  }

  async getRawTransaction(txid: string, verbose = true, blockhash?: string): Promise<unknown> {
    return this.call('getrawtransaction', blockhash ? [txid, verbose, blockhash] : [txid, verbose]);
  }

  async getBlockchainInfo(): Promise<unknown> {
    return this.call('getblockchaininfo');
  }

  async getMiningInfo(): Promise<unknown> {
    return this.call('getmininginfo');
  }

  async getNetworkInfo(): Promise<unknown> {
    return this.call('getnetworkinfo');
  }

  async getPeerInfo(): Promise<unknown[]> {
    return this.call<unknown[]>('getpeerinfo');
  }

  async getRawMemPool(): Promise<string[]> {
    return this.call<string[]>('getrawmempool');
  }

  async getMempoolInfo(): Promise<unknown> {
    return this.call('getmempoolinfo');
  }

  async getMempoolEntry(txid: string): Promise<unknown> {
    return this.call('getmempoolentry', [txid]);
  }

  async getDifficulty(): Promise<number> {
    return this.call<number>('getdifficulty');
  }

  async getNetworkHashPS(blocks = 120, height = -1): Promise<number> {
    return this.call<number>('getnetworkhashps', [blocks, height]);
  }

  async getTxOutSetInfo(): Promise<unknown> {
    return this.call('gettxoutsetinfo');
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getBlockCount();
      return true;
    } catch {
      return false;
    }
  }
}

export const rpcService = new RpcService();
