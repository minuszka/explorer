import { expect, test } from '@playwright/test';
import { stubApi } from './apiStub';

// The font- and style-related directives the server sends in production (helmet in
// server/src/index.ts). upgrade-insecure-requests is left out: it would move this plain-HTTP
// preview to HTTPS.
const PRODUCTION_FONT_CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
].join('; ');

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

test('the site fonts load from this origin under the production content security policy @smoke', async ({ page }) => {
  const externalFontRequests: string[] = [];
  page.on('request', (request) => {
    if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) externalFontRequests.push(request.url());
  });
  const fontPolicyViolations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/.test(message.text()) && /font-src|style-src/.test(message.text())) {
      fontPolicyViolations.push(message.text());
    }
  });
  await page.route('**/about', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': PRODUCTION_FONT_CSP } });
  });

  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();

  const fonts = await page.evaluate(async () => {
    const requested = ['500 16px "Space Grotesk Variable"', '400 16px "IBM Plex Mono"', '600 16px "IBM Plex Mono"'];
    const loaded = await Promise.all(requested.map(async (font) => {
      const faces = await document.fonts.load(font);
      return faces.filter((face) => face.status === 'loaded').map((face) => `${face.family.replace(/"/g, '')} ${face.weight}`);
    }));
    return { loaded, bodyFamily: getComputedStyle(document.body).fontFamily };
  });

  expect(fonts.loaded).toEqual([['Space Grotesk Variable 300 700'], ['IBM Plex Mono 400'], ['IBM Plex Mono 600']]);
  expect(fonts.bodyFamily.startsWith('"Space Grotesk Variable"')).toBe(true);
  expect(externalFontRequests).toEqual([]);
  expect(fontPolicyViolations).toEqual([]);
});

const statsWithLastBlockAgo = (seconds: number) => ({
  success: true,
  data: {
    blockHeight: 130_000,
    lastBlockTime: Math.floor(Date.now() / 1000) - seconds,
    difficulty: 1,
    hashrate: 1,
    connections: 8,
    mempool: { size: 0, bytes: 0 },
    supply: { circulating: 1, max: null },
    blockReward: 1,
    stakingReward: 0,
    avgBlockTime: 150,
    totalTransactions: 1,
    totalAddresses: 1,
    masternodes: 1,
    stakingWallets: 1,
  },
});

const delayedStats = () => statsWithLastBlockAgo(11 * 60);

// The longest status labels leave the least room next to them. Every case must fit on one row
// without sideways scrolling, with 40px search and menu buttons. Up to 520px the header shows the
// logo without the title (which stays the link's name); below 360px the block height moves to the
// menu while the status is not "Live". "Polling" is healthy but as long as "Delayed".
const NARROW_HEADER_CASES = [
  { width: 600, label: 'Disconnected', titleShown: true, heightInTopBar: true },
  { width: 521, label: 'Disconnected', titleShown: true, heightInTopBar: true },
  { width: 360, label: 'Delayed', titleShown: false, heightInTopBar: true },
  { width: 360, label: 'Disconnected', titleShown: false, heightInTopBar: true },
  { width: 360, label: 'Polling', titleShown: false, heightInTopBar: true },
  { width: 320, label: 'Delayed', titleShown: false, heightInTopBar: false },
  { width: 320, label: 'Disconnected', titleShown: false, heightInTopBar: false },
  { width: 320, label: 'Polling', titleShown: false, heightInTopBar: false },
];

const disconnectedSync = {
  success: true,
  data: { isRunning: false, lastSyncedHeight: 130_000, daemonHeight: -1, rpcConnected: false, blocksRemaining: 0, progress: 0, error: null },
};

for (const { width, label, titleShown, heightInTopBar } of NARROW_HEADER_CASES) {
  test(`a ${width}px screen fits the header on one row beside "${label}" @smoke`, async ({ page }) => {
    await page.unroute('**/api/**');
    // A closed realtime connection with a current chain is "Polling".
    if (label === 'Polling') await page.routeWebSocket('**/ws', (socket) => socket.close());
    await stubApi(page, label === 'Disconnected'
      ? { '/api/stats': delayedStats(), '/api/sync': disconnectedSync }
      : { '/api/stats': label === 'Polling' ? statsWithLastBlockAgo(60) : delayedStats() });
    await page.setViewportSize({ width, height: 780 });

    await page.goto('/');
    await expect(page.locator('.status-chip-live').first()).toContainText(label);
    await expect(page.locator('header').getByRole('link', { name: 'DeFCoN Explorer' })).toBeVisible();
    const layout = await page.evaluate(async () => {
      await document.fonts.ready;
      const title = document.querySelector('.header-brand-title') as HTMLElement;
      const titleBox = title.getBoundingClientRect();
      const titleText = document.createRange();
      titleText.selectNodeContents(title);
      const shown = titleBox.width > 2;
      const actions = Array.from(document.querySelectorAll('.header-top-actions .status-chip, .header-top-actions button'))
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width > 0);
      const heightChip = document.querySelector('.header-top-actions .status-chip-height')?.getBoundingClientRect();
      const width = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect().width;
      return {
        titleFont: getComputedStyle(title).fontFamily.split(',')[0],
        titleShown: shown,
        titleLines: shown ? titleBox.height / parseFloat(getComputedStyle(title).lineHeight) : 0,
        brandRight: Math.max(
          (document.querySelector('.header-brand-logo') as HTMLElement).getBoundingClientRect().right,
          shown ? titleText.getBoundingClientRect().right : 0,
        ),
        firstActionLeft: Math.min(...actions.map((box) => box.left)),
        lastActionRight: Math.max(...actions.map((box) => box.right)),
        actionsTop: Math.min(...actions.map((box) => box.top)),
        actionsBottom: Math.max(...actions.map((box) => box.bottom)),
        header: (document.querySelector('header.header') as HTMLElement).getBoundingClientRect().toJSON() as DOMRect,
        searchWidth: width('.search-toggle'),
        menuWidth: width('.mobile-toggle'),
        heightInTopBar: (heightChip?.width ?? 0) > 0,
        pageWidth: document.documentElement.scrollWidth,
      };
    });

    expect(layout.titleFont).toBe('"Space Grotesk Variable"');
    expect(layout.titleShown).toBe(titleShown);
    if (titleShown) expect(layout.titleLines).toBeLessThan(1.5);
    expect(layout.brandRight).toBeLessThanOrEqual(layout.firstActionLeft);
    expect(layout.lastActionRight).toBeLessThanOrEqual(width);
    expect(layout.actionsBottom - layout.actionsTop).toBeLessThanOrEqual(40);
    // The top bar keeps space above and below its buttons instead of touching the header's edges.
    expect(layout.actionsTop - layout.header.top).toBeGreaterThanOrEqual(4);
    expect(layout.header.bottom - layout.actionsBottom).toBeGreaterThanOrEqual(4);
    expect(layout.pageWidth).toBe(width);
    expect(layout.heightInTopBar).toBe(heightInTopBar);
    expect(layout.searchWidth).toBeGreaterThanOrEqual(40);
    expect(layout.menuWidth).toBeGreaterThanOrEqual(40);
  });
}
