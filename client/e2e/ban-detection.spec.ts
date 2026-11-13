import { expect, test } from '@playwright/test';
import { stubApi } from './apiStub';

const path = '/api/v1/masternodes/ban-waves';
function fixture() {
  const now = new Date();
  const activation = new Date(now.getTime() - 3_600_000);
  const point = { bucket: activation.toISOString(), timestamp: Math.floor(activation.getTime() / 1000), waveBans: 0, isolatedBans: 2, recovered: 1, stillBanned: 1, total: 2, cumulative: 2 };
  return {
    generatedAt: now.toISOString(), rpcAvailable: true, dataStatus: 'fresh', bucket: '15min',
    analysisScope: { kind: 'q60', from: activation.toISOString(), activatedAt: activation.toISOString(), activationHeight: 144888, historyLimited: false, unclassifiedEvents: 1 },
    registeredTotal: 217, currentValid: 166, currentPoseBanned: 51, currentPosePenalty: 2,
    kpis: { windowWaveCount: 0, windowLargestWave: 0, meanTimeBetweenWavesSec: null },
    timeline: [point], timelineModes: { fresh: [point], recovered: [point], still: [point], all: [point] }, waveBands: [], waves: [],
    trackedNodes: [
      { nodeId: 'a', proTxHash: 'protx-a', service: '198.51.100.1:8192', banCount: 2, lastBanAt: now.toISOString(), lastBanHeight: 144947, recoveredAt: now.toISOString(), currentStatus: 'POSE_PENALTY', currentPenalty: 112 },
      { nodeId: 'b', proTxHash: 'protx-b', service: '198.51.100.2:8192', banCount: 1, lastBanAt: now.toISOString(), lastBanHeight: 144899, recoveredAt: null, currentStatus: 'POSE_BANNED', currentPenalty: 220 },
    ],
  };
}

test('Q60 view separates current counts and repeated identities, includes isolated bans @smoke', async ({ page }, testInfo) => {
  const requests: URL[] = [];
  page.on('request', (request) => { if (request.url().includes(path)) requests.push(new URL(request.url())); });
  await stubApi(page, { [path]: { success: true, data: fixture() } });
  await page.goto('/ban-detection');
  await expect(page.getByRole('tab', { name: 'Since Q60' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.bd-current-stats')).toContainText('217');
  await expect(page.locator('.bd-current-stats')).toContainText('166');
  await expect(page.getByText('3 distinct ban events')).toBeVisible();
  await expect(page.getByText('1 events excluded: ban block unknown')).toBeVisible();
  await expect(page.locator('.bd-node-panel tbody tr')).toHaveCount(2);
  await expect(page.locator('.bd-node-panel tbody')).toContainText('112');
  expect(requests[0].searchParams.get('scope')).toBe('q60');
  await page.screenshot({ path: testInfo.outputPath('ban-detection-q60.png'), fullPage: true });
  await page.getByLabel('Repeated bans only').check();
  await expect(page.locator('.bd-node-panel tbody tr')).toHaveCount(1);
  await page.getByLabel('Repeated bans only').uncheck();
  await expect(page.locator('.bd-node-panel tbody tr')).toHaveCount(2);
  await page.getByLabel('Find node').fill('198.51.100.2');
  await expect(page.locator('.bd-node-panel tbody tr')).toHaveCount(1);
  await expect(page.locator('.bd-node-panel tbody')).toContainText('POSE_BANNED');
  await page.getByLabel('Minimum nodes').selectOption('5');
  await expect.poll(() => requests.at(-1)?.searchParams.get('minNodes')).toBe('5');
  await page.getByRole('tab', { name: '24h', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.get('scope')).toBe('rolling');
  await page.screenshot({ path: testInfo.outputPath('ban-detection.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('unavailable RPC never appears as zero healthy nodes @smoke', async ({ page }) => {
  await stubApi(page, { [path]: { success: true, data: { ...fixture(), rpcAvailable: false } } });
  await page.goto('/ban-detection');
  await expect(page.locator('.bd-current-stats .mnh-stat-value').filter({ hasText: 'Unknown' })).toHaveCount(4);
  await expect(page.getByText('Live RPC unavailable', { exact: false })).toBeVisible();
});

test('stale history is marked and current counts are unknown @smoke', async ({ page }) => {
  await stubApi(page, { [path]: { success: true, data: { ...fixture(), dataStatus: 'stale' } } });
  await page.goto('/ban-detection');
  await expect(page.getByText('Cached historical data', { exact: false })).toBeVisible();
  await expect(page.locator('.bd-current-stats .mnh-stat-value').filter({ hasText: 'Unknown' })).toHaveCount(4);
});

test('failed refresh removes previous current counts @smoke', async ({ page }) => {
  await stubApi(page, { [path]: { success: true, data: fixture() } });
  await page.goto('/ban-detection');
  await expect(page.locator('.bd-current-stats')).toContainText('217');
  await page.route(`**${path}*`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false }) }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Ban analysis unavailable.', { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.bd-current-stats')).not.toContainText('217');
});

test('a node with a proTxHash links to its masternode page; the service still filters this page @smoke', async ({ page }) => {
  const data = fixture();
  data.trackedNodes[0].proTxHash = 'a'.repeat(64);
  await stubApi(page, { [path]: { success: true, data } });
  await page.goto('/ban-detection');
  const panel = page.locator('.bd-node-panel tbody');
  await expect(panel.getByRole('link', { name: 'aaaaaaaa...aaaaaaaa' })).toHaveAttribute('href', `/masternode/${'a'.repeat(64)}`);
  await expect(panel.getByRole('link', { name: '198.51.100.1:8192' })).toHaveAttribute('href', `/ban-detection?node=${'a'.repeat(64)}`);
  // "protx-b" is not a proTxHash: its line stays plain text.
  await expect(panel.locator('tr').nth(1).locator('.mnh-meta-line a')).toHaveCount(0);
});
