import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';
import { SITE_NAME, resolveRouteSeo } from '@defcon/shared';
import { config } from './config';
import { renderBootData } from './utils/bootData';
import { connectDatabase } from './config/database';
import { logger } from './utils/logger';
import { syncService } from './services/sync.service';
import { masternodePollerService } from './services/masternodePoller.service';
import { networkHealthService } from './services/networkHealth.service';
import { seedNodeService } from './services/seedNode.service';
import { nodeInventoryService } from './services/nodeInventory.service';
import { poseChainService } from './services/poseChain.service';
import { networkNoiseRetentionService } from './services/networkNoiseRetention.service';
import { cachePrewarmService } from './services/cachePrewarm.service';
import { realtimeService } from './services/realtime.service';
import { telegramService } from './services/telegram.service';
import { resolveRequestIp } from './utils/requestIp';
import {
  normalizeSpaShellPath,
  SPA_SHELL_RESPONSE_CACHE_CONTROL,
  SpaShellCache,
} from './utils/spaShellCache';
import apiRoutes from './routes';
import { rejectUnknownApiRequest } from './middleware/apiNotFound';
import { getStatsPayload } from './routes/stats.routes';
import { getDashboardPayload } from './routes/dashboard.routes';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.http.trustProxy);

// Permissive trust proxy + IP-based rate limiting is a footgun: a misconfigured
// upstream lets a remote attacker spoof X-Forwarded-For and bypass per-IP
// throttling. Warn loudly in production if the operator opted into the most
// permissive value (`true` / `'all'`).
if (
  config.nodeEnv === 'production' &&
  (config.http.trustProxy === true || config.http.trustProxy === 'all')
) {
  logger.warn(
    '[security] trust proxy is set to a permissive value in production. ' +
      'Set TRUST_PROXY to the exact number of upstream hops (e.g. 1 for nginx-only, 2 for Cloudflare+nginx) ' +
      'and ensure the upstream OVERWRITES X-Forwarded-For / X-Real-IP. Otherwise per-IP rate limits can be spoofed.'
  );
}

function applyNoStoreHeaders(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function getPublicSiteUrl(): string {
  return config.publicSiteUrl;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function replaceOrInsertTag(html: string, tagRegex: RegExp, tag: string): string {
  if (tagRegex.test(html)) return html.replace(tagRegex, tag);
  return html.replace('</head>', `  ${tag}\n  </head>`);
}

function renderSeoHtml(indexHtml: string, pathname: string): { html: string; robots: string } {
  const siteUrl = getPublicSiteUrl();
  const seo = resolveRouteSeo(pathname);
  const canonical = `${siteUrl}${seo.canonicalPath}`;
  const fullTitle = seo.title.includes('DefTrack') ? seo.title : `${seo.title} | DefTrack`;

  let html = indexHtml;
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(fullTitle)}</title>`);
  html = replaceOrInsertTag(
    html,
    /<link[^>]*rel=["']canonical["'][^>]*>/i,
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`
  );
  html = replaceOrInsertTag(
    html,
    /<meta[^>]*name=["']description["'][^>]*>/i,
    `<meta name="description" content="${escapeHtml(seo.description)}" />`
  );
  html = replaceOrInsertTag(
    html,
    /<meta[^>]*name=["']keywords["'][^>]*>/i,
    `<meta name="keywords" content="${escapeHtml(seo.keywords)}" />`
  );
  html = replaceOrInsertTag(
    html,
    /<meta[^>]*name=["']robots["'][^>]*>/i,
    `<meta name="robots" content="${escapeHtml(seo.robots)}" />`
  );
  html = replaceOrInsertTag(
    html,
    /<meta[^>]*name=["']googlebot["'][^>]*>/i,
    `<meta name="googlebot" content="${escapeHtml(seo.robots)}" />`
  );
  html = replaceOrInsertTag(
    html,
    /<meta[^>]*property=["']og:site_name["'][^>]*>/i,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />`
  );
  html = replaceOrInsertTag(
    html,
    /<meta[^>]*property=["']og:title["'][^>]*>/i,
    `<meta property="og:title" content="${escapeHtml(fullTitle)}" />`
  );
  html = replaceOrInsertTag(
    html,
    /<meta[^>]*property=["']og:description["'][^>]*>/i,
    `<meta property="og:description" content="${escapeHtml(seo.description)}" />`
  );
  html = replaceOrInsertTag(
    html,
    /<meta[^>]*property=["']og:url["'][^>]*>/i,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`
  );
  html = replaceOrInsertTag(
    html,
    /<meta[^>]*name=["']twitter:title["'][^>]*>/i,
    `<meta name="twitter:title" content="${escapeHtml(fullTitle)}" />`
  );
  html = replaceOrInsertTag(
    html,
    /<meta[^>]*name=["']twitter:description["'][^>]*>/i,
    `<meta name="twitter:description" content="${escapeHtml(seo.description)}" />`
  );
  return { html, robots: seo.robots };
}

const spaShellCache = new SpaShellCache();

function applySpaShellCacheHeaders(res: express.Response): void {
  res.setHeader('Cache-Control', SPA_SHELL_RESPONSE_CACHE_CONTROL);
  res.setHeader('CDN-Cache-Control', SPA_SHELL_RESPONSE_CACHE_CONTROL);
  res.setHeader('Cloudflare-CDN-Cache-Control', SPA_SHELL_RESPONSE_CACHE_CONTROL);
  res.setHeader('X-Cache-Profile', 'spa-shell-revalidate');
}

// Embed the first-paint API payloads into the SPA shell so the client can
// render real data before its first fetch. The client seeds these into the
// React Query cache as already-stale entries, so it still revalidates in the
// background — worst case the boot data is shell-cache age (~60s edge) old.
async function buildBootScript(pathname: string): Promise<string> {
  try {
    const wantsDashboard = normalizeSpaShellPath(pathname) === '/';
    const [stats, overview] = await Promise.all([
      getStatsPayload().catch(() => null),
      wantsDashboard ? getDashboardPayload().catch(() => null) : Promise.resolve(null),
    ]);

    const boot: Record<string, unknown> = {};
    if (stats?.data) boot.stats = stats.data;
    if (overview?.data) boot.dashboardOverview = overview.data;
    if (Object.keys(boot).length === 0) return '';

    return renderBootData(boot);
  } catch {
    return '';
  }
}

function isSeoControlFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.endsWith('/robots.txt') ||
    normalized.endsWith('/sitemap.xml') ||
    normalized.endsWith('/llms.txt') ||
    normalized.endsWith('/llms-full.txt')
  );
}

// AI discovery files (llms.txt, llms-full.txt, .well-known/*) are meant to be
// fetched cross-origin by AI agents/crawlers, so always allow them.
function isAiDiscoveryFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.endsWith('/llms.txt') ||
    normalized.endsWith('/llms-full.txt') ||
    normalized.includes('/.well-known/')
  );
}

// Fail-fast warning: admin routes require ADMIN_API_KEY in production
if (config.nodeEnv === 'production' && !config.admin.apiKey) {
  logger.warn(
    'SECURITY WARNING: ADMIN_API_KEY is not set. ' +
    '/api/admin/* routes will return 500 until this is configured.'
  );
}

function startBackgroundServices(reason: string): void {
  if (mongoose.connection.readyState !== 1) {
    logger.warn(`Skipping background services start (${reason}) - MongoDB not connected.`);
    return;
  }

  syncService.start().catch((err) => {
    logger.error(`Failed to start sync service (${reason}):`, err);
  });
  masternodePollerService.start().catch((err) => {
    logger.error(`Failed to start masternode poller (${reason}):`, err);
  });
  networkHealthService.start().catch((err) => {
    logger.error(`Failed to start network health poller (${reason}):`, err);
  });
  seedNodeService.start().catch((err) => {
    logger.error(`Failed to start seed node poller (${reason}):`, err);
  });
  nodeInventoryService.start().catch((err) => {
    logger.error(`Failed to start node inventory scanner (${reason}):`, err);
  });
  cachePrewarmService.start();
  poseChainService.start().catch(() => logger.warn('PoSe chain collector could not start'));
  networkNoiseRetentionService.start().catch(() => logger.warn('Network noise receipt retention could not start'));
  telegramService.start();
}

// Middleware
app.use(
  helmet({
    strictTransportSecurity:
      config.nodeEnv === 'production'
        ? {
            maxAge: 31536000, // 1 year
            includeSubDomains: true,
            preload: true,
          }
        : false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://www.googletagmanager.com'],
        // Vite/recharts inline styles require 'unsafe-inline'. Removing it
        // would break the SPA; the rest of the CSP narrows the blast radius.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://www.google-analytics.com'],
        connectSrc: [
          "'self'",
          // Only allow plaintext WebSocket in dev; production must use wss://.
          ...(config.nodeEnv === 'production' ? ['wss:'] : ['ws:', 'wss:']),
          'https://www.google-analytics.com',
          'https://region1.google-analytics.com',
          'https://www.googletagmanager.com',
        ],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        frameSrc: ["'none'"],
        formAction: ["'self'"],
        // Prevent legacy http:// subresource downgrades when behind TLS.
        ...(config.nodeEnv === 'production'
          ? { upgradeInsecureRequests: [] }
          : {}),
      },
    },
  })
);

// Helmet v7 typings in this project do not expose `permissionsPolicy`,
// so we set the header explicitly.
app.use((_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    [
      'accelerometer=()',
      'camera=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'payment=()',
      'usb=()',
    ].join(', ')
  );
  next();
});

const corsOrigins = config.cors.origins;
if (config.nodeEnv === 'production' && corsOrigins.length === 0) {
  logger.warn('CORS_ORIGINS is not configured; browser cross-origin requests are blocked by default.');
}
app.use(
  cors({
    origin: (origin, callback) => {
      // Non-browser calls (health checks, curl, internal probes) have no Origin header.
      if (!origin) return callback(null, true);

      if (corsOrigins.length === 0) {
        if (config.nodeEnv !== 'production') {
          return callback(null, true);
        }
        return callback(null, false);
      }

      return callback(null, corsOrigins.includes(origin));
    },
  })
);

app.use(compression());
app.use(express.json());

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.maxRequestsPerMinute,
  // Don't expose remaining quota to clients: standard headers help honest
  // consumers, but they also tell an attacker exactly how many requests they
  // can still send before the bucket resets. We rely on 429 alone.
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => resolveRequestIp(req, config.rateLimit.ipHeaders),
  // Health checks are routed through a separate, more permissive limiter
  // (see `healthLimiter`) so that probes never starve real API traffic and
  // can still be rate limited against floods.
  skip: (req) => req.path.startsWith('/health'),
});

// Dedicated, higher-quota limiter for /health/* probes. Without this, an
// attacker could hammer the health endpoint to exhaust the Mongoose ping
// pool. Quota is 10x the default so legitimate orchestrator probes are
// never throttled.
const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Math.max(60, config.rateLimit.maxRequestsPerMinute * 10),
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => resolveRequestIp(req, config.rateLimit.ipHeaders),
});

// Strict per-IP limiter for /api/admin/*. Sits in front of the auth
// middleware so brute force attempts trip a 429 long before they could
// burn through the global quota. 30 attempts / 15 min is generous for a
// human operator typing keys, but cripples scripted enumeration.
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => resolveRequestIp(req, config.rateLimit.ipHeaders),
});

// Defense-in-depth: ensure all JSON responses declare UTF-8 explicitly so
// downstream proxies / browsers cannot misinterpret encoding.
app.use((_req, res, next) => {
  const orig = res.json.bind(res);
  res.json = (body: unknown) => {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    return orig(body);
  };
  next();
});

// API Routes
app.use('/api', (_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
});
// Apply the dedicated, more permissive limiter to health probes BEFORE the
// general apiLimiter sees them. apiLimiter intentionally skips /health.
app.use('/api/health', healthLimiter);
// Admin path gets its own strict limiter ahead of the global apiLimiter.
app.use('/api/admin', adminAuthLimiter);
app.use('/api', apiLimiter, apiRoutes);
app.use('/api', rejectUnknownApiRequest);

// Serve React frontend in production
if (config.nodeEnv === 'production') {
  const clientPath = path.join(__dirname, '../../client/dist');
  const indexPath = path.join(clientPath, 'index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf8');

  const serveSpaShell = async (req: express.Request, res: express.Response) => {
    const { html, robots } = spaShellCache.get(indexHtml, req.path || '/', renderSeoHtml);
    const bootScript = await buildBootScript(req.path || '/');
    const finalHtml = bootScript ? html.replace('</head>', `${bootScript}</head>`) : html;
    applySpaShellCacheHeaders(res);
    res.setHeader('X-Robots-Tag', robots);
    res.type('html').send(finalHtml);
  };

  app.get('/index.html', serveSpaShell);

  app.use(
    express.static(clientPath, {
      index: false,
      etag: true,
      setHeaders: (res, filePath) => {
        if (isAiDiscoveryFile(filePath)) {
          res.setHeader('Access-Control-Allow-Origin', '*');
        }

        if (isSeoControlFile(filePath)) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
          return;
        }

        if (filePath.endsWith('index.html')) {
          applyNoStoreHeaders(res);
          return;
        }

        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return;
        }

        res.setHeader('Cache-Control', 'public, max-age=3600');
      },
    })
  );

  app.get('*', (req, res) => {
    if (path.extname(req.path)) {
      return res.status(404).end();
    }
    return serveSpaShell(req, res);
  });
}

// Start server
async function start() {
  await connectDatabase();

  const server = app.listen(config.port, '127.0.0.1', () => {
    logger.info(`DeFCoN Explorer API running on port ${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info(`Binding: 127.0.0.1:${config.port} (localhost only)`);
  });
  realtimeService.init(server);

  // Start background sync/poller now (if DB is already connected).
  startBackgroundServices('startup');

  // If DB reconnects later, attempt to start background services automatically.
  mongoose.connection.on('connected', () => {
    startBackgroundServices('db-connected-event');
  });
}

async function stopServices(): Promise<void> {
  telegramService.stop();
  cachePrewarmService.stop();
  networkHealthService.stop();
  seedNodeService.stop();
  networkNoiseRetentionService.stop();
  await Promise.all([
    syncService.stop(),
    masternodePollerService.stop(),
    nodeInventoryService.stop(),
    poseChainService.stop(),
    realtimeService.shutdown(),
  ]);
}

// Process-level safety nets
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception - shutting down:', err);
  stopServices().finally(() => process.exit(1));
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  await stopServices();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  await stopServices();
  process.exit(0);
});

start().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
