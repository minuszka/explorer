import { expect, test, type Page, type Route } from '@playwright/test';
import { stubApi } from './apiStub';

const blocksChunk = '**/assets/BlocksPage-*.js';
const missing = (route: Route) => route.fulfill({ status: 404, body: '' });
// These assertions wait through a second full page load.
const afterReload = { timeout: 15000 };

function countDocuments(page: Page) {
  const seen = { documents: 0 };
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) seen.documents += 1;
  });
  return seen;
}

// This link exists on desktop and mobile, and following it starts no hover preload.
async function openBlocksFromDashboard(page: Page) {
  await page.goto('/');
  await page.locator('.latest-card').filter({ has: page.getByRole('heading', { name: 'Latest Blocks', exact: true }) })
    .getByRole('link', { name: 'View all' }).click();
}

const notice = (page: Page) => page.getByRole('status').filter({ hasText: 'Part of the site could not be loaded' });

async function expectPanelThenGoHome(page: Page) {
  const panel = page.getByRole('alert').filter({ hasText: 'This page could not be loaded' });
  await expect(panel).toBeVisible();
  await expect(page.locator('header').first()).toBeVisible();
  await panel.getByRole('link', { name: 'Go Home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Latest Blocks', exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

test('a page removed by a newer release reloads once and then opens @smoke', async ({ page }) => {
  const seen = countDocuments(page);
  let removed = true;
  await page.route(blocksChunk, (route) => {
    if (!removed) return route.fallback();
    removed = false;
    return missing(route);
  });
  await openBlocksFromDashboard(page);
  await expect(page.getByRole('heading', { name: 'Latest DeFCoN Blocks' })).toBeVisible(afterReload);
  await expect(page).toHaveURL(/\/blocks$/);
  await expect(notice(page)).toHaveCount(0);
  expect(seen.documents).toBe(2);
});

test('a page that stays missing ends on a panel instead of a reload loop @smoke', async ({ page }, testInfo) => {
  const seen = countDocuments(page);
  await page.route(blocksChunk, missing);
  await openBlocksFromDashboard(page);
  const reload = page.getByRole('button', { name: 'Reload page' });
  await expect(reload).toBeVisible(afterReload);
  await page.waitForTimeout(1500);
  expect(seen.documents).toBe(2);
  await page.screenshot({ path: testInfo.outputPath('missing-page-panel.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await reload.click();
  await expect.poll(() => seen.documents, afterReload).toBe(3);
  await expect(reload).toBeVisible(afterReload);
  await page.waitForTimeout(1500);
  expect(seen.documents).toBe(3);

  await expectPanelThenGoHome(page);
  expect(seen.documents).toBe(3);
});

test('an error while rendering a page shows the panel without reloading @smoke', async ({ page }) => {
  const seen = countDocuments(page);
  await page.route(blocksChunk, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'export default function BrokenPage() { throw new Error("render failed"); }',
  }));
  await openBlocksFromDashboard(page);
  await expectPanelThenGoHome(page);
  expect(seen.documents).toBe(1);
});

test('moving to another query on the same page clears the failure @smoke', async ({ page }) => {
  const seen = countDocuments(page);
  await page.route('**/assets/SearchResultsPage-*.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'export default function Picky() { if (location.search.includes("bad")) throw new Error("bad query"); return null; }',
  }));
  await page.goto('/search?q=bad');
  const panel = page.getByRole('alert').filter({ hasText: 'This page could not be loaded' });
  await expect(panel).toBeVisible();
  await page.evaluate(() => {
    const state = { usr: null, key: 'other-query', idx: 1 };
    window.history.pushState(state, '', '/search?q=good');
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  });
  await expect(panel).toHaveCount(0);
  expect(seen.documents).toBe(1);
});

test('a chunk that fails offline keeps the tab open and loads after reconnecting @smoke', async ({ page, context }) => {
  const seen = countDocuments(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Latest Blocks', exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.locator('.latest-card').filter({ has: page.getByRole('heading', { name: 'Latest Blocks', exact: true }) })
    .getByRole('link', { name: 'View all' }).click();
  const reload = page.getByRole('button', { name: 'Reload page' });
  await expect(reload).toBeVisible();
  expect(seen.documents).toBe(1);

  await context.setOffline(false);
  await reload.click();
  await expect(page.getByRole('heading', { name: 'Latest DeFCoN Blocks' })).toBeVisible(afterReload);
  expect(seen.documents).toBe(2);
});

test('without session storage a missing page shows the panel and does not reload @smoke', async ({ page }) => {
  const seen = countDocuments(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('storage blocked'); } });
  });
  await page.route(blocksChunk, missing);
  await openBlocksFromDashboard(page);
  await expectPanelThenGoHome(page);
  expect(seen.documents).toBe(1);
});

test('a failed hover preload waits for the next navigation to reload @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Hover preloading only exists on desktop.');
  const seen = countDocuments(page);
  let requested = 0;
  await page.route('**/assets/ApiPage-*.js', (route) => {
    requested += 1;
    return missing(route);
  });
  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await navigation.getByRole('link', { name: 'API', exact: true }).hover();
  await expect.poll(() => requested).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();
  await expect(notice(page)).toBeVisible();
  expect(seen.documents).toBe(1);

  // A new query stays on the loaded page, so it must not reload the tab.
  await page.evaluate(() => {
    const state = { usr: null, key: 'same-page', idx: 1 };
    window.history.pushState(state, '', '/about?section=team');
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  });
  await expect(page).toHaveURL(/\/about\?section=team$/);
  await page.waitForTimeout(1000);
  expect(seen.documents).toBe(1);

  await navigation.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => seen.documents, afterReload).toBe(2);
  await expect(page.getByRole('heading', { name: 'Latest Blocks', exact: true })).toBeVisible(afterReload);
  await expect(notice(page)).toHaveCount(0);
});

for (const [name, setup] of [
  ['session storage is blocked', () => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('storage blocked'); } });
  }],
  ['the tab has just reloaded', () => {
    window.sessionStorage.setItem('defcon.chunkReloadAt', String(Date.now()));
  }],
] as const) {
  test(`a failed stylesheet offers a reload when ${name} @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Hover preloading only exists on desktop.');
    const seen = countDocuments(page);
    await page.addInitScript(setup);
    await page.route('**/assets/MiningPage-*.css', missing);
    await page.goto('/about');
    await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();
    const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
    await navigation.getByRole('link', { name: 'Rewards', exact: true }).hover();
    await expect(notice(page)).toBeVisible();

    await navigation.getByRole('link', { name: 'Rewards', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Network Rewards' })).toBeVisible();
    await expect(notice(page)).toBeVisible();
    await page.waitForTimeout(1000);
    expect(seen.documents).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('failed-stylesheet-notice.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.unroute('**/assets/MiningPage-*.css', missing);
    await notice(page).getByRole('button', { name: 'Reload page' }).click();
    await expect.poll(() => seen.documents, afterReload).toBe(2);
    await expect(page.getByRole('heading', { name: 'Network Rewards' })).toBeVisible(afterReload);
    await expect(notice(page)).toHaveCount(0);
  });
}

test('a stylesheet that fails after its page opened still offers a reload @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Hover preloading only exists on desktop.');
  const seen = countDocuments(page);
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  await page.route('**/assets/MiningPage-*.css', async (route) => {
    requested = true;
    await opened;
    await missing(route);
  });
  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();
  const rewards = page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Rewards', exact: true });
  await rewards.hover();
  await expect.poll(() => requested).toBe(true);
  await rewards.click();
  await expect(page.getByRole('heading', { name: 'Network Rewards' })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);

  release();
  await expect(notice(page).getByRole('button', { name: 'Reload page' })).toBeVisible();
  await page.waitForTimeout(1000);
  expect(seen.documents).toBe(1);
});
