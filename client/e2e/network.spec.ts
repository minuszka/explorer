import { expect, test } from '@playwright/test';
import { stubApi } from './apiStub';

const path = '/api/v1/node-inventory/active-versions';
function fixture() {
  const now = new Date().toISOString();
  return {
    generatedAt: now, statusObservedAt: now, inventoryPollSeconds: 300,
    versionMaxAgeSeconds: 86400, requiredVersion: '23.0.0',
    summary: { total: 4, enabled: 3, posePenalty: 1, fresh: 2, stale: 1, unknown: 1,
      coveragePct: 50, recommended: 2, deprecated: 1 },
    versions: [
      { version: '23.0.0', count: 2, sharePct: 50, isDeprecated: false },
      { version: '22.1.4', count: 1, sharePct: 25, isDeprecated: true },
    ],
    nodes: [
      { id: 'a', ip: '198.51.100.1', status: 'ENABLED', walletVersion: '23.0.0', versionState: 'fresh', isDeprecated: false },
      { id: 'b', ip: '198.51.100.2', status: 'POSE_PENALTY', walletVersion: '22.1.4', versionState: 'fresh', isDeprecated: true },
      { id: 'c', ip: '198.51.100.3', status: 'ENABLED', walletVersion: '23.0.0', versionState: 'stale', isDeprecated: false },
      { id: 'd', ip: '198.51.100.4', status: 'ENABLED', walletVersion: null, versionState: 'unknown', isDeprecated: false },
    ].map((node) => ({ ...node, port: 8192, sources: ['Direct peer'], lastInventoryObservedAt: now,
      lastVersionObservedAt: node.versionState === 'unknown' ? null : node.versionState === 'stale' ? '2026-07-01T00:00:00Z' : now })),
  };
}

const network = { success: true, data: { connections: 1, protocolversion: 70242, blockHeight: 100,
  peers: [{ addr: '203.0.113.1:8192', subver: '/DeFCoN:23.0.0/', synced_blocks: 100, synced_headers: 100, inbound: false }] } };

test('last-known version shares include older observations and keep direct peers separate @smoke', async ({ page }, testInfo) => {
  await stubApi(page, { [path]: { success: true, data: fixture() }, '/api/network': network });
  await page.goto('/network');
  await expect(page.getByRole('heading', { name: 'Active Masternode Versions' })).toBeVisible();
  await expect(page.locator('.network-version-row')).toHaveCount(3);
  await expect(page.locator('.network-version-row').first()).toContainText('50.0% of active');
  await expect(page.locator('.network-version-summary')).toContainText('2 (50.0%)');
  await expect(page.getByRole('button', { name: /Stale version/ })).toHaveCount(0);
  // The masternodes themselves are listed once, on the Masternodes page: no table here.
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open the Masternodes table' })).toHaveAttribute('href', '/masternodes');
  await expect(page.getByText('Page refresh: 30s.', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('network.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Each version row opens the Masternodes table filtered to that version.
  await expect(page.locator('.network-version-row').first()).toHaveAttribute('href', '/masternodes?version=23.0.0');
  await expect(page.getByRole('link', { name: /Unknown version/ })).toHaveAttribute('href', '/masternodes?version=unknown');

  // Direct peers are still filtered in place.
  await page.getByRole('button', { name: 'Direct peers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Direct Peer Versions' })).toBeVisible();
  await expect(page.locator('.network-version-row').first()).toContainText('100.0% of peers');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.locator('.network-version-row').first().click();
  await expect(page.getByRole('button', { name: 'Clear version filter' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByText('Version collection:', { exact: false })).toHaveCount(0);
});

test('unavailable data remains visible even without any peers @smoke', async ({ page }) => {
  await stubApi(page);
  await page.goto('/network');
  await expect(page.getByText('Active masternode data is unavailable.', { exact: false })).toBeVisible();
  await expect(page.locator('.network-version-row')).toHaveCount(0);
  // The way to the masternode list stays, even without the version summary.
  await expect(page.getByRole('link', { name: 'Open the Masternodes table' })).toHaveAttribute('href', '/masternodes');
});

test('a valid snapshot with zero active MNs has a clear empty state @smoke', async ({ page }) => {
  const data = fixture();
  data.summary = { total: 0, enabled: 0, posePenalty: 0, fresh: 0, stale: 0, unknown: 0,
    coveragePct: 0, recommended: 0, deprecated: 0 };
  data.versions = [];
  data.nodes = [];
  await stubApi(page, { [path]: { success: true, data } });
  await page.goto('/network');
  await expect(page.getByText('No active masternodes in the current snapshot.')).toBeVisible();
  await expect(page.locator('.network-version-summary')).toContainText('0.0%');
});

test('a failed refresh hides previously successful percentages @smoke', async ({ page }) => {
  await page.clock.install();
  await stubApi(page, { [path]: { success: true, data: fixture() }, '/api/network': network });
  await page.goto('/network');
  await expect(page.locator('.network-version-row')).toHaveCount(3);
  await page.route(`**${path}`, (route) => route.fulfill({ status: 503, json: { success: false } }));
  await page.clock.fastForward(31_000);
  await page.clock.resume();
  await expect(page.getByText('Active masternode data is unavailable.', { exact: false })).toBeVisible();
  await expect(page.locator('.network-version-row')).toHaveCount(0);
  await expect(page.locator('.network-version-summary')).toHaveCount(0);
});
