import { expect, test } from '@playwright/test';
import { stubApi } from './apiStub';
import { headerSearchField, openHeaderSearch } from './headerSearch';

// Every page has the search in its header: in the top bar on wide screens, behind a search
// button on phones. A query goes to /search, which opens the object's own page.

const HASH = 'a'.repeat(64);
const BLOCK_TIME = 1_788_609_600;

function block(height: number) {
  return {
    hash: HASH, height, confirmations: 3, size: 538, version: 0x20000000, merkleroot: 'b'.repeat(64),
    time: BLOCK_TIME, mediantime: BLOCK_TIME, nonce: 0, bits: '190a969d', difficulty: 400_000_000, chainwork: '0', nTx: 0,
    rewardSat: 1_050_000_000_000, totalValueOutSat: 0, txids: [], reward: 10_500, totalValueOut: 0,
  };
}

test('a height typed into the header search on the About page opens that block @smoke', async ({ page }) => {
  await stubApi(page, {
    '/api/search': { success: true, data: { type: 'block', matchedBy: 'height', result: { height: 123_456, hash: HASH } } },
    '/api/block/123456': { success: true, data: block(123_456) },
    '/api/block/123456/txs': { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } },
  });

  await page.goto('/about');
  const search = await openHeaderSearch(page);
  await search.fill('123456');
  await search.press('Enter');

  await expect(page).toHaveURL(/\/block\/123456$/);
  await expect(page.getByRole('heading', { name: 'Block #123,456' })).toBeVisible();
  // The field is cleared for the next search; on a phone its row closes again.
  await expect(search).toHaveValue('');
});

test('"/" jumps to the header search, but not while typing in another field @smoke', async ({ page }) => {
  await stubApi(page);
  const search = headerSearchField(page);

  await page.goto('/about');
  await expect(page.locator('main')).toBeVisible();
  await page.keyboard.press('/');
  await expect(search).toBeVisible();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');

  await page.goto('/search');
  const pageField = page.getByRole('searchbox', { name: 'Search the chain' });
  await pageField.click();
  await page.keyboard.type('a/b');
  await expect(pageField).toHaveValue('a/b');
  await expect(search).not.toBeFocused();
});

test('an empty search does nothing, and Escape closes the phone search row @smoke', async ({ page }, testInfo) => {
  await stubApi(page);
  await page.goto('/about');
  const search = await openHeaderSearch(page);

  await search.press('Enter');
  await expect(page).toHaveURL(/\/about$/);

  await search.press('Escape');
  await expect(search).not.toBeFocused();
  if (testInfo.project.name === 'mobile-chromium') {
    await expect(search).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open search' })).toHaveAttribute('aria-expanded', 'false');
  } else {
    await expect(search).toBeVisible();
  }
});

test('on a phone the search button opens a full-width search row under the top bar @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Wide screens show the field in the top bar.');
  await stubApi(page);
  await page.goto('/about');

  const search = headerSearchField(page);
  await expect(search).toBeHidden();
  await page.getByRole('button', { name: 'Open search' }).click();
  await expect(search).toBeFocused();
  await expect(page.getByRole('button', { name: 'Close search' })).toHaveAttribute('aria-expanded', 'true');

  const [row, topBar, viewport] = await Promise.all([
    search.boundingBox(),
    page.locator('.header-top-actions').boundingBox(),
    page.viewportSize(),
  ]);
  if (!row || !topBar || !viewport) throw new Error('Header search row was not laid out.');
  expect(row.y).toBeGreaterThanOrEqual(topBar.y + topBar.height);
  expect(row.width).toBeGreaterThan(viewport.width - 40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('on a phone the menu drawer keeps space around its content @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'The drawer is the narrow-screen menu.');
  await stubApi(page);
  await page.goto('/about');
  await page.getByRole('button', { name: 'Open menu' }).click();

  const drawer = page.locator('.mobile-drawer');
  await expect(drawer).toBeVisible();
  const [drawerBox, firstChip] = await Promise.all([
    drawer.boundingBox(),
    drawer.locator('.status-chip').first().boundingBox(),
  ]);
  if (!drawerBox || !firstChip) throw new Error('Menu drawer was not laid out.');
  expect(firstChip.y - drawerBox.y).toBeGreaterThanOrEqual(8);
});

test('the desktop header is compact and its logo is a small image @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'The two-row header is the wide-screen layout.');
  await stubApi(page);
  await page.goto('/about');

  const header = await page.locator('header.header').boundingBox();
  expect(header?.height ?? 0).toBeLessThanOrEqual(106);
  await expect(page.locator('header').getByRole('searchbox', { name: 'Search the explorer' })).toBeVisible();

  const logo = page.locator('.header-brand-logo');
  await expect(logo).toBeVisible();
  const src = await logo.getAttribute('src');
  const response = await page.request.get(src ?? '');
  expect(response.ok()).toBe(true);
  expect((await response.body()).length).toBeLessThan(10_000);
});
