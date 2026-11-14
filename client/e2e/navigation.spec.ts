import { expect, test } from '@playwright/test';
import { stubApi } from './apiStub';

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

test('navigation cleanup keeps block browsing and redirects the retired wallet page @smoke', async ({ page }, testInfo) => {
  await page.goto('/blocks');
  await expect(page.getByRole('heading', { name: 'Latest DeFCoN Blocks' })).toBeVisible();
  const footer = page.getByRole('navigation', { name: 'Footer links' });
  await expect(footer.locator('a[href="/blocks"], a[href="/wallets"]')).toHaveCount(0);
  await page.goto('/wallets');
  await expect(page).toHaveURL(/\/richlist$/);
  await expect(page.getByRole('heading', { name: 'Rich List', exact: true })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/richlist$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/blocks$/);
  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByRole('button', { name: 'Open menu' }).click();
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(nav.getByRole('link', { name: 'Latest Blocks', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Top Wallets', exact: true })).toHaveCount(0);
    await nav.getByRole('link', { name: 'Rich List', exact: true }).click();
    await expect(page).toHaveURL(/\/richlist$/);
  }
  await page.goto('/');
  await page.locator('.latest-card').filter({ has: page.getByRole('heading', { name: 'Latest Blocks', exact: true }) })
    .getByRole('link', { name: 'View all' }).click();
  await expect(page).toHaveURL(/\/blocks$/);
});

test('desktop primary and dropdown navigation preserve their routes @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop navigation is covered in the desktop project.');

  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();

  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await primaryNavigation.getByRole('link', { name: 'API', exact: true }).click();
  await expect(page).toHaveURL(/\/api$/);
  await expect(page.getByRole('heading', { name: 'API Documentation' })).toBeVisible();

  await primaryNavigation.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();

  await primaryNavigation.getByRole('button', { name: 'Explorer', exact: true }).click();
  await expect(primaryNavigation.getByRole('menuitem', { name: 'Mempool', exact: true })).toHaveCount(0);
  await expect(primaryNavigation.getByRole('menuitem', { name: 'Wallet Distribution', exact: true })).toHaveCount(0);
  await expect(primaryNavigation.getByRole('menuitem', { name: 'Latest Blocks', exact: true })).toHaveCount(0);
  await expect(primaryNavigation.getByRole('menuitem', { name: 'Top Wallets', exact: true })).toHaveCount(0);
  await primaryNavigation.getByRole('menuitem', { name: 'Transactions', exact: true }).click();
  await expect(page).toHaveURL(/\/txs$/);
  await expect(page.getByRole('heading', { name: 'Latest DEFCON Transactions' })).toBeVisible();

  await primaryNavigation.getByRole('button', { name: 'Dev Tools', exact: true }).click();
  await primaryNavigation.getByRole('menuitem', { name: 'Node Inventory', exact: true }).click();
  await expect(page).toHaveURL(/\/devtools\/node-inventory$/);
  await expect(page.getByRole('heading', { name: 'Node Version & Chain Inventory' })).toBeVisible();
});

// The menu groups the masternode pages together and leaves Dev Tools to developer pages. Blocks,
// Mempool and Bubblemaps stay out of the menu.
const MENU = [
  { label: 'Dashboard', items: [] },
  { label: 'Explorer', items: ['Transactions', 'Rich List'] },
  { label: 'Masternodes', items: ['Masternode List', 'PoSe Watch', 'Rewards'] },
  { label: 'Network', items: ['Overview', 'Nodes'] },
  { label: 'API', items: [] },
  { label: 'About', items: [] },
  { label: 'Dev Tools', items: ['Node Inventory', 'Network Noise Monitor', 'PoSe Penalty Watch'] },
];

test('desktop menu groups the masternode pages under Masternodes @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop navigation is covered in the desktop project.');

  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();
  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const topLevel = primaryNavigation.locator(':scope > a, :scope > .header-nav-dropdown > button');
  await expect(topLevel).toHaveText(MENU.map((entry) => entry.label));

  for (const { label, items } of MENU.filter((entry) => entry.items.length > 0)) {
    const toggle = primaryNavigation.getByRole('button', { name: label, exact: true });
    await toggle.click();
    await expect(primaryNavigation.getByRole('menuitem')).toHaveText(items);
    await toggle.click();
    await expect(primaryNavigation.getByRole('menuitem')).toHaveCount(0);
  }

  // Each masternode page marks Masternodes as the current section, and none marks Dev Tools.
  for (const [item, url, heading] of [
    ['PoSe Watch', /\/ban-detection$/, 'PoSe Watch'],
    ['Rewards', /\/mining$/, 'Network Rewards'],
    ['Masternode List', /\/masternodes$/, 'Masternodes'],
  ] as const) {
    await primaryNavigation.getByRole('button', { name: 'Masternodes', exact: true }).click();
    await primaryNavigation.getByRole('menuitem', { name: item, exact: true }).click();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expect(primaryNavigation.getByRole('button', { name: 'Masternodes', exact: true })).toHaveClass(/\bactive\b/);
    await expect(primaryNavigation.getByRole('button', { name: 'Dev Tools', exact: true })).not.toHaveClass(/\bactive\b/);
  }

  // Both network pages mark only Network as the current section.
  for (const [item, url, heading] of [
    ['Overview', /\/network$/, 'Network'],
    ['Nodes', /\/chain-health$/, 'Nodes'],
  ] as const) {
    await primaryNavigation.getByRole('button', { name: 'Network', exact: true }).click();
    await primaryNavigation.getByRole('menuitem', { name: item, exact: true }).click();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();
    await expect(primaryNavigation.locator(':scope > a.active, :scope > .header-nav-dropdown > button.active'))
      .toHaveText(['Network']);
  }
});

test('hovering Node Inventory in the desktop menu starts loading its page @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Hover preloading only exists on desktop.');
  let requested = 0;
  page.on('request', (request) => {
    if (/\/assets\/NodeInventoryPage-[^/]*\.js$/.test(request.url())) requested += 1;
  });

  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();
  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await primaryNavigation.getByRole('button', { name: 'Dev Tools', exact: true }).click();
  const nodeInventory = primaryNavigation.getByRole('menuitem', { name: 'Node Inventory', exact: true });
  await expect(nodeInventory).toBeVisible();
  expect(requested).toBe(0);

  await nodeInventory.hover();
  await expect.poll(() => requested).toBeGreaterThan(0);
});

test('desktop header brand and navigation align with the dashboard shell @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'This is a desktop alignment check.');

  await page.goto('/');
  await expect(page.locator('.dashboard-hero')).toBeVisible();

  const [brandBox, navigationBox, dashboardBox] = await Promise.all([
    page.locator('.header-brand').boundingBox(),
    page.locator('.header-nav-shell').boundingBox(),
    page.locator('.dashboard-hero').boundingBox(),
  ]);
  if (!brandBox || !navigationBox || !dashboardBox) throw new Error('Header alignment elements were not rendered.');

  expect(Math.abs(brandBox.x - dashboardBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(navigationBox.x - dashboardBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((navigationBox.x + navigationBox.width) - (dashboardBox.x + dashboardBox.width))).toBeLessThanOrEqual(1);
});

test('dashboard keeps duplicate network metrics out of the search hero @smoke', async ({ page }) => {
  await page.goto('/');

  const dashboardHero = page.locator('.dashboard-hero');
  await expect(dashboardHero).toBeVisible();
  await expect(dashboardHero.locator('.hero-metrics')).toHaveCount(0);
  await expect(dashboardHero.getByText('Market snapshot', { exact: true })).toHaveCount(0);
  for (const label of ['Indexed height', 'Last block', 'Peers', 'Masternodes']) {
    await expect(dashboardHero.getByText(label, { exact: true })).toHaveCount(0);
  }
});

test('dashboard marks a delayed market quote as stale @smoke', async ({ page }) => {
  await page.unroute('**/api/**');
  await stubApi(page, {
    '/api/market': {
      success: true,
      data: {
        available: true,
        source: 'qutrade',
        lastUpdatedAt: '2026-09-05T08:00:19.000Z',
        freshness: 'stale',
        ageSeconds: 42_000,
        price: {
          usd: 0.000008052,
          btc: null,
          change24h: -6.3,
          volume24h: null,
          marketCap: null,
        },
      },
    },
  });

  await page.goto('/');
  await expect(page.getByText(/Market data delayed/)).toBeVisible();
  await expect(page.getByText('Market data delayed · 11h 40m ago')).toBeVisible();
});

test('header does not report live when the indexed chain is delayed @smoke', async ({ page }) => {
  await page.unroute('**/api/**');
  await stubApi(page, {
    '/api/stats': {
      success: true,
      data: {
        blockHeight: 130_000,
        lastBlockTime: Math.floor(Date.now() / 1000) - 11 * 60,
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
    },
  });

  await page.goto('/');
  const status = page.locator('.status-chip-live').first();
  await expect(status).toContainText('Delayed');
  await expect(status).toHaveClass(/degraded/);
  await expect(status).toHaveAttribute('title', /Latest indexed block is .*old/);
});

test('header shows a current chain without realtime connection as healthy polling, not as a warning @smoke', async ({ page }) => {
  await page.routeWebSocket('**/ws', (socket) => socket.close());
  await page.unroute('**/api/**');
  await stubApi(page, {
    '/api/stats': {
      success: true,
      data: {
        blockHeight: 130_000,
        lastBlockTime: Math.floor(Date.now() / 1000) - 60,
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
    },
  });

  await page.goto('/');
  const status = page.locator('.status-chip-live').first();
  await expect(status).toContainText('Polling');
  await expect(status).toHaveAttribute('title', /Indexed chain is current/);
  await expect(status).not.toHaveClass(/degraded/);
  // The chip keeps the healthy (green) colour of "Live".
  const colours = await status.evaluate((chip) => ({
    label: getComputedStyle(chip.querySelector('.status-chip-label') as Element).color,
    success: getComputedStyle(document.documentElement).getPropertyValue('--success').trim(),
  }));
  const probe = await page.evaluate((value) => {
    const element = document.createElement('span');
    element.style.color = value;
    document.body.append(element);
    const rgb = getComputedStyle(element).color;
    element.remove();
    return rgb;
  }, colours.success);
  expect(colours.label).toBe(probe);
});

test('mobile drawer exposes the same top-level navigation @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile navigation is covered in the mobile project.');

  await page.goto('/about');
  await page.getByRole('button', { name: 'Open menu' }).click();
  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(primaryNavigation.getByRole('link', { name: 'About', exact: true })).toBeVisible();

  await primaryNavigation.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
});

test('mobile drawer groups the masternode pages under Masternodes @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile navigation is covered in the mobile project.');

  await page.goto('/about');
  await page.getByRole('button', { name: 'Open menu' }).click();
  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const topLevel = primaryNavigation.locator(':scope > a, :scope > .mobile-nav-group > .mobile-nav-group-label');
  await expect(topLevel).toHaveText(MENU.map((entry) => entry.label));

  for (const { label, items } of MENU.filter((entry) => entry.items.length > 0)) {
    const group = primaryNavigation.locator('.mobile-nav-group')
      .filter({ has: page.locator('.mobile-nav-group-label', { hasText: new RegExp(`^${label}$`) }) });
    await expect(group.getByRole('link')).toHaveText(items);
  }

  await primaryNavigation.getByRole('link', { name: 'Rewards', exact: true }).click();
  await expect(page).toHaveURL(/\/mining$/);
  await expect(page.getByRole('heading', { name: 'Network Rewards', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await primaryNavigation.getByRole('link', { name: 'PoSe Watch', exact: true }).click();
  await expect(page).toHaveURL(/\/ban-detection$/);
  await expect(page.getByRole('heading', { name: 'PoSe Watch', level: 1 })).toBeVisible();
});

test('the site stays dark for light-mode visitors and offers no theme switch @smoke', async ({ page }) => {
  // A visitor whose system prefers light mode and who saved the retired light theme earlier.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    window.localStorage.setItem('defcon-theme', 'light');
  });

  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toggle theme' })).toHaveCount(0);

  const rendered = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  }));
  expect(rendered).toEqual({ background: 'rgb(7, 17, 31)', colorScheme: 'dark' });
});
