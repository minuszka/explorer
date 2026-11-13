import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './apiStub';

// Round numbers so the figures can be checked by hand:
// masternode payment 10,500 - 500 = 10,000 DFCN; 86,400 / 144 s = 600 blocks a day → 6,000,000 DFCN a day
// for 120 online masternodes = 50,000 each → 18,250,000 a year on a 1,000,000 collateral = 1825.00%.
// Locked: 120 × 1,000,000 = 120,000,000 of 12,000,000,000 = 1.0% (one decimal, as on the Rewards page).
const STATS = {
  blockHeight: 130_000,
  lastBlockTime: 1_788_000_000,
  difficulty: 1,
  hashrate: 1,
  connections: 8,
  mempool: { size: 0, bytes: 0 },
  supply: { circulating: 12_000_000_000, max: null },
  blockReward: 10_500,
  stakingReward: 500,
  avgBlockTime: 144,
  txCount24h: 1_234,
  totalValueTransferred24h: 5_000_000,
  txCount30d: 30_000,
  avgTxPerBlock30d: 2,
  txTrend30d: [],
  flow24h: [],
  newAddresses24h: 1,
  newAddresses7d: 1,
  totalTransactions: 1,
  totalAddresses: 1,
  masternodes: 100,
  stakingWallets: 5,
};
const COIN = {
  NAME: 'DeFCoN', TICKER: 'DFCN', ADDRESS_PREFIX: 'D', DECIMALS: 8, MAX_SUPPLY: null,
  BLOCK_TIME_SECONDS: 150, INITIAL_REWARD: 10_000, HALVING_INTERVAL: 0, MASTERNODE_COLLATERAL: 1_000_000,
};
const SUMMARY = { total: 125, enabled: 120, poseBanned: 5, posePenalty: 0, countries: 2 };
const MARKET = {
  available: true,
  source: 'qutrade',
  lastUpdatedAt: '2026-09-05T08:00:19.000Z',
  freshness: 'fresh',
  ageSeconds: 30,
  price: { usd: 0.000008052, btc: null, change24h: 1.5, volume24h: null, marketCap: null },
};

function api(stats: Record<string, unknown> = STATS) {
  return {
    '/api/dashboard/overview': { success: true, data: { stats, blocks: [], txs: [] } },
    '/api/stats': { success: true, data: stats },
    '/api/coin': { success: true, data: COIN },
    '/api/masternodes/summary': { success: true, data: SUMMARY },
    '/api/market': { success: true, data: MARKET },
  };
}

function without(responses: Record<string, Record<string, unknown>>, ...paths: string[]) {
  return Object.fromEntries(Object.entries(responses).filter(([path]) => !paths.includes(path)));
}

function metric(page: Page, label: string) {
  return page.locator('.dashboard-metric').filter({ has: page.locator(`dt:text-is("${label}")`) });
}

async function expectMetric(page: Page, label: string, value: string) {
  await expect(metric(page, label).locator('.dashboard-metric-value')).toHaveText(value);
}

/** For every figure: how many lines its text takes and how much of its tile's inner width it leaves free. */
async function figureFit(page: Page) {
  return page.locator('.dashboard-metric').evaluateAll((tiles) => tiles.map((tile) => {
    const value = tile.querySelector('.dashboard-metric-value') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(value);
    const lines = new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size;
    const style = getComputedStyle(tile);
    const inner = tile.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const text = range.getBoundingClientRect().width;
    return { value: value.textContent, lines, slack: (inner - text) / inner, tileRight: tile.getBoundingClientRect().right };
  }));
}

async function expectFiguresOnOneLine(page: Page) {
  const fit = await figureFit(page);
  const hero = await page.locator('.dashboard-hero').boundingBox();
  if (!hero) throw new Error('The dashboard hero was not rendered.');
  for (const figure of fit) {
    expect(figure.lines, `${figure.value} stays on one line`).toBe(1);
    // Room to spare, because Linux Chromium draws this font a few per cent wider than Windows:
    // the price at 360 px leaves about 11% on Windows; a tile that is nearly full (about 1%) fails here.
    expect(figure.slack, `${figure.value} leaves room in its tile`).toBeGreaterThan(0.03);
    expect(figure.tileRight).toBeLessThanOrEqual(hero.x + hero.width + 0.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('the dashboard metrics row shows price, supply, ROI, block time, locked collateral and 24h transactions @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.goto('/');

  await expect(page.locator('.dashboard-metric')).toHaveCount(6);
  await expectMetric(page, 'DFCN / USD', '$0.000008052');
  await expect(metric(page, 'DFCN / USD').locator('.dashboard-market-change')).toHaveText('+1.50%');
  await expectMetric(page, 'Circulating supply', '12B DFCN');
  await expect(metric(page, 'Circulating supply').locator('.dashboard-metric-value')).toHaveAttribute('title', '12,000,000,000 DFCN');
  await expectMetric(page, 'Masternode ROI', '1825.00%');
  await expectMetric(page, 'Avg block time', '2m 24s');
  await expectMetric(page, 'Collateral locked', '1.0%');
  await expectMetric(page, 'Transactions (24h)', '1,234');
  // The 24h transaction count is shown once, in the row, not again in Live Flow.
  await expect(page.getByText('Transactions (24h)', { exact: true })).toHaveCount(1);
});

test('the Rewards page and the dashboard show the same masternode ROI @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.goto('/mining');
  await expect(page.locator('.rewards-detail-card--roi')).toContainText('1825.00%');
  await page.goto('/');
  await expectMetric(page, 'Masternode ROI', '1825.00%');
});

test('without the masternode list the ROI falls back to the active count from the stats, like the Rewards page @smoke', async ({ page }) => {
  // 100 active masternodes: 60,000 DFCN a day each → 21,900,000 a year = 2190.00%; 100,000,000 of 12,000,000,000 = 0.8%.
  await stubApi(page, without(api(), '/api/masternodes/summary'));
  await page.goto('/');
  await expectMetric(page, 'Masternode ROI', '2190.00%');
  await expectMetric(page, 'Collateral locked', '0.8%');
});

test('while the masternode list loads the ROI waits instead of showing the fallback figure @smoke', async ({ page }) => {
  await stubApi(page, api());
  let release: () => void = () => {};
  const listHeld = new Promise<void>((resolve) => { release = resolve; });
  // Registered after stubApi, so it answers the masternode list first, and only when released.
  await page.route('**/api/masternodes/summary', async (route) => {
    await listHeld;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: SUMMARY }) });
  });
  const coinAnswered = page.waitForResponse('**/api/coin');
  await page.goto('/');
  await coinAnswered;
  await expectMetric(page, 'Transactions (24h)', '1,234');
  // Stats and coin are in; with the list missing the fallback would read 2190.00%.
  await page.waitForTimeout(500);
  await expectMetric(page, 'Masternode ROI', '...');
  await expectMetric(page, 'Collateral locked', '...');
  release();
  await expectMetric(page, 'Masternode ROI', '1825.00%');
});

test('a figure the API does not give shows N/A, and zero transactions is still a figure @smoke', async ({ page }) => {
  const stats = { ...STATS, supply: { circulating: 0, max: null }, avgBlockTime: 0, txCount24h: 0 };
  await stubApi(page, without(api(stats), '/api/coin', '/api/market'));
  await page.goto('/');

  await expectMetric(page, 'DFCN / USD', 'N/A');
  await expectMetric(page, 'Circulating supply', 'N/A');
  await expectMetric(page, 'Masternode ROI', 'N/A');
  await expectMetric(page, 'Avg block time', 'N/A');
  await expectMetric(page, 'Collateral locked', 'N/A');
  await expectMetric(page, 'Transactions (24h)', '0');
});

test('when the dashboard data fails every figure shows N/A @smoke', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.locator('.dashboard-metric-value')).toHaveCount(6);
  for (const value of await page.locator('.dashboard-metric-value').all()) {
    await expect(value).toHaveText('N/A');
  }
});

/** Waits until every figure shows its final value, so a measurement never sees "..." first. */
async function expectFinalFigures(page: Page) {
  await expectMetric(page, 'DFCN / USD', '$0.000008052');
  await expectMetric(page, 'Circulating supply', '12B DFCN');
  await expectMetric(page, 'Masternode ROI', '1825.00%');
  await expectMetric(page, 'Avg block time', '2m 24s');
  await expectMetric(page, 'Collateral locked', '1.0%');
  await expectMetric(page, 'Transactions (24h)', '1,234');
}

test('the six figures fit inside the hero: one row on desktop, two columns on a phone @smoke', async ({ page }, testInfo) => {
  await stubApi(page, api());
  await page.goto('/');
  await expectFinalFigures(page);

  const hero = await page.locator('.dashboard-hero').boundingBox();
  if (!hero) throw new Error('The dashboard hero was not rendered.');
  const boxes = [];
  for (const card of await page.locator('.dashboard-metric').all()) {
    const box = await card.boundingBox();
    if (!box) throw new Error('A metric was not rendered.');
    boxes.push(box);
  }
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(hero.x);
    expect(box.x + box.width).toBeLessThanOrEqual(hero.x + hero.width + 0.5);
  }
  const columns = new Set(boxes.map((box) => Math.round(box.x))).size;
  const rows = new Set(boxes.map((box) => Math.round(box.y))).size;
  if (testInfo.project.name === 'mobile-chromium') {
    expect(columns).toBe(2);
    expect(rows).toBe(3);
  } else {
    expect(columns).toBe(6);
    expect(rows).toBe(1);
  }
  await expectFiguresOnOneLine(page);
});

// The narrowest tile of each layout: 2 columns on a 360 px phone, 3 columns just above 520 px,
// 6 columns just above 1080 px; 1100 px is the width the design review uses, 1080 px the widest 3-column one.
const NARROW_WIDTHS: Record<string, number[]> = {
  'mobile-chromium': [360, 521],
  'desktop-chromium': [1081, 1100, 1080],
};

test('at the narrowest width of each layout every figure, the long price too, stays on one line @smoke', async ({ page }, testInfo) => {
  await stubApi(page, api());
  for (const width of NARROW_WIDTHS[testInfo.project.name] ?? []) {
    await test.step(`${width} px`, async () => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      await expectFinalFigures(page);
      await expectFiguresOnOneLine(page);
    });
  }
});

test('the masternode list behind the ROI refreshes on its own, like on the Rewards page @smoke', async ({ page }) => {
  await page.clock.install();
  await stubApi(page, api());
  let listRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/masternodes/summary') listRequests += 1;
  });
  await page.goto('/');
  await expectMetric(page, 'Masternode ROI', '1825.00%');
  const before = listRequests;
  await page.clock.runFor(91_000);
  await expect.poll(() => listRequests).toBeGreaterThan(before);
});
