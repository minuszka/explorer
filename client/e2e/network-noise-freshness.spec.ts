import { expect, test } from '@playwright/test';
import { stubApi } from './apiStub';

const path = '/api/v1/network-noise/summary';
function summary(reportingNodes: number) {
  return { success: true, data: {
    generatedAt: new Date().toISOString(), windowHours: 24, staleAfterSeconds: 180,
    summary: { currentScore: 0, currentLevel: 'quiet', knownNodes: 1, reportingNodes,
      staleNodes: 1 - reportingNodes, activeSignals: 0, chainAlerts: 0 },
    nodes: [{ nodeId: 'observer-a', nodeRole: 'fullnode', walletVersion: null, agentVersion: '2.0.0',
      lastReportedAt: new Date(Date.now() - (reportingNodes ? 1000 : 3600000)).toISOString(), blockHeight: null,
      bestBlockHash: null, chainLockHeight: null, chainLockHash: null, connections: null, inbound: null,
      outbound: null, syncing: null, noiseScore: 0, signalCount: 0, activeSignalTypes: [], lastCleanAt: null,
      isStale: !reportingNodes }], timeline: [], recentSignals: [],
  } };
}

test('no fresh reporters is unknown rather than a quiet network @smoke', async ({ page }) => {
  await stubApi(page, { [path]: summary(0) });
  await page.goto('/devtools/network-noise');
  const noise = page.locator('.nn-stat').filter({ hasText: 'Current noise' });
  await expect(noise.locator('strong')).toHaveText('Unknown');
  await expect(noise).toContainText('No fresh reports');
  await expect(page.locator('.nn-stat').filter({ hasText: 'Active signals' }).locator('strong')).toHaveText('Unknown');
  await expect(page.locator('.nn-stat').filter({ hasText: 'Chain alerts' }).locator('strong')).toHaveText('Unknown');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a fresh clean report remains quiet @smoke', async ({ page }) => {
  await stubApi(page, { [path]: summary(1) });
  await page.goto('/devtools/network-noise');
  await expect(page.locator('.nn-stat').filter({ hasText: 'Current noise' }).locator('strong')).toHaveText('Quiet');
  await expect(page.locator('.nn-stat').filter({ hasText: 'Active signals' }).locator('strong')).toHaveText('0');
});

test('a nearly expired reporter becomes unknown without waiting for the next fetch @smoke', async ({ page }) => {
  await page.clock.install();
  const data = summary(1);
  data.data.nodes[0].lastReportedAt = new Date(Date.now() - 179000).toISOString();
  await stubApi(page, { [path]: data });
  await page.goto('/devtools/network-noise');
  const noise = page.locator('.nn-stat').filter({ hasText: 'Current noise' });
  await expect(noise.locator('strong')).toHaveText('Quiet');
  await page.clock.fastForward(3000);
  await expect(noise.locator('strong')).toHaveText('Unknown');
  await expect(page.locator('.nn-table tbody tr').first()).toContainText('STALE');
});

test('a stalled refresh cannot keep old reports current and a new snapshot restores them @smoke', async ({ page }) => {
  await page.clock.install();
  await stubApi(page, { [path]: summary(1) });
  await page.goto('/devtools/network-noise');
  const noise = page.locator('.nn-stat').filter({ hasText: 'Current noise' });
  await expect(noise.locator('strong')).toHaveText('Quiet');
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${path}?*`, async (route) => {
    await waiting;
    const now = await page.evaluate(() => Date.now());
    const data = summary(1);
    data.data.generatedAt = new Date(now).toISOString();
    data.data.nodes[0].lastReportedAt = new Date(now - 1000).toISOString();
    await route.fulfill({ json: data });
  });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Refreshing...' })).toBeVisible();
  await page.clock.fastForward(181000);
  await expect(noise.locator('strong')).toHaveText('Unknown');
  await expect(page.locator('.nn-stat').filter({ hasText: 'Reporting nodes' }).locator('strong')).toHaveText('Unknown');
  release();
  await expect(noise.locator('strong')).toHaveText('Quiet');
});

test('an inconsistent fresh-reporter count cannot establish current noise @smoke', async ({ page }) => {
  const data = summary(1);
  data.data.nodes[0].isStale = true;
  await stubApi(page, { [path]: data });
  await page.goto('/devtools/network-noise');
  await expect(page.locator('.nn-stat').filter({ hasText: 'Current noise' }).locator('strong')).toHaveText('Unknown');
});

test('a future snapshot timestamp cannot establish current noise @smoke', async ({ page }) => {
  const data = summary(1);
  data.data.generatedAt = new Date(Date.now() + 60000).toISOString();
  await stubApi(page, { [path]: data });
  await page.goto('/devtools/network-noise');
  await expect(page.locator('.nn-stat').filter({ hasText: 'Current noise' }).locator('strong')).toHaveText('Unknown');
});

test('a failed summary request does not claim a quiet network @smoke', async ({ page }) => {
  await stubApi(page);
  await page.goto('/devtools/network-noise');
  const noise = page.locator('.nn-stat').filter({ hasText: 'Current noise' });
  await expect(noise.locator('strong')).toHaveText('Unknown', { timeout: 15000 });
  await expect(noise).toContainText('Telemetry unavailable');
});
