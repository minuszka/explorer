import { expect, test } from '@playwright/test';
import { stubApi } from './apiStub';

// The block page tells a block that does not exist apart from one it could not load.

test('a block the explorer does not have is reported as not found @smoke', async ({ page }) => {
  await stubApi(page);
  let requests = 0;
  await page.route('**/api/block/123', (route) => {
    requests += 1;
    return route.fulfill({ status: 404, json: { success: false, error: { code: 'NOT_FOUND', message: 'Block not found' } } });
  });

  await page.goto('/block/123');

  await expect(page.getByText('Block not found', { exact: true })).toBeVisible();
  await expect(page.getByText('Block "123" was not found. It may not be synced yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse Blocks' })).toHaveAttribute('href', '/blocks');
  await expect(page.getByText('Block could not be loaded')).toHaveCount(0);
  // A "not found" answer does not change on a retry.
  expect(requests).toBe(1);
});

test('a block that fails to load is reported as an error, not as missing @smoke', async ({ page }) => {
  await stubApi(page);
  let requests = 0;
  await page.route('**/api/block/123', (route) => {
    requests += 1;
    return route.fulfill({ status: 500, json: { success: false, error: { code: 'INTERNAL', message: 'Failed to fetch block' } } });
  });

  await page.goto('/block/123');

  const panel = page.locator('.state-panel[data-tone="danger"]');
  await expect(panel.getByText('Block could not be loaded')).toBeVisible();
  await expect(panel).toContainText('Failed to fetch block');
  await expect(page.getByText('Block not found', { exact: true })).toHaveCount(0);
  // A server error is tried once more before the page gives up.
  expect(requests).toBe(2);
});
