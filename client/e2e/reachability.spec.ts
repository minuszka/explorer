import { expect, test } from '@playwright/test';
import type { DnsSeederNodesApiResponse } from '@defcon/shared';
import { stubApi } from './apiStub';

const path = '/api/network/dns-seeder-nodes';
function fixture(count = 2): DnsSeederNodesApiResponse {
  const now = new Date().toISOString();
  return { success: true, data: Array.from({ length: count }, (_, i) => ({
    ip: `198.51.100.${i + 1}`, port: 8192, blockHeight: i === 0 ? 100 : null,
    snapshotBlockHeight: 90, bestBlockHash: 'b'.repeat(64), isLivePeer: i === 0,
    livePeerObservedAt: i === 0 ? now : null, uptime2h: i === 0 ? 100 : 0,
    lastSeen: '2026-10-01T00:00:00.000Z', walletVersion: '23.0.0',
    walletVersionSource: i === 0 ? 'explorer-daemon' : 'dns-seeder',
    protocolVersion: 70242, protocolVersionSource: 'dns-seeder', peerCount: null,
  })), meta: { generatedAt: now,
    dnsSeeder: { status: 'ok', fetchedAt: now, lastAttemptAt: now, sourceObservedAt: null,
      completeness: 'unknown', receivedRows: count, rejectedRows: 0, duplicateRows: 0,
      omittedRows: 0, returnedRows: count, limit: 10_000 },
    daemonPeers: { status: 'ok', observedAt: now }, portFailureEvidence: 'unavailable' } };
}
function seeds() {
  return { success: true, data: [1, 2].map(i => ({ ip: `203.0.113.${i}`, label: `Seed ${i}`,
    reachable: true, fetchedAt: Date.now(), chainStatus: 'seed-baseline', blockHeight: 100, bestBlockHash: 'a'.repeat(64) })) };
}

test('source times, unknown reachability and crawler hash stay separate from live chain evidence @smoke', async ({ page }, testInfo) => {
  await stubApi(page, { [path]: fixture(), '/api/network/seed-nodes': seeds() });
  await page.goto('/chain-health');
  const panel = page.locator('.dns-seeder-card');
  await expect(panel.getByText('LIVE PEER', { exact: true })).toHaveCount(1);
  await expect(panel.getByText('REACHABILITY UNKNOWN', { exact: true })).toHaveCount(1);
  await expect(panel.getByText('HEIGHT MATCH ONLY', { exact: true })).toBeVisible();
  await expect(panel.getByText('HASH MISMATCH', { exact: true })).toHaveCount(0);
  await expect(panel.locator('.badge.warning, .badge.error, .operator-action-row')).toHaveCount(0);
  await expect(panel.getByText('Port 8192', { exact: true })).toHaveCount(2);
  await expect(panel.getByText('0%', { exact: true })).toBeVisible();
  await panel.getByText('Source times and coverage', { exact: true }).click();
  await expect(panel.getByText('Crawler snapshot time and feed completeness: unknown.', { exact: false })).toBeVisible();
  await expect(panel.getByText('Explorer daemon peers: ok.', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('reachability-sources.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('all returned endpoints can be reached with manual pagination @smoke', async ({ page }) => {
  await stubApi(page, { [path]: fixture(126) });
  await page.goto('/chain-health');
  const panel = page.locator('.dns-seeder-card');
  await expect(panel.locator('tbody tr')).toHaveCount(25);
  await expect(panel.getByText('Page 1 of 6 · 126 endpoints', { exact: true })).toBeVisible();
  for (let i = 0; i < 5; i++) await panel.getByRole('button', { name: 'Next endpoints' }).click();
  await expect(panel.locator('tbody tr')).toHaveCount(1);
  await expect(panel.locator('tbody')).toContainText('198.51.100.126');
  await expect(panel.getByRole('button', { name: 'Next endpoints' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Previous endpoints' }).click();
  await expect(panel.getByText('Page 5 of 6 · 126 endpoints', { exact: true })).toBeVisible();
});

test('stale feed and unavailable daemon remain neutral and expose their limits @smoke', async ({ page }) => {
  const data = fixture();
  data.data.forEach(node => { node.isLivePeer = false; node.livePeerObservedAt = null; node.blockHeight = null; });
  data.meta.dnsSeeder.status = 'stale';
  data.meta.dnsSeeder.omittedRows = 10;
  data.meta.dnsSeeder.receivedRows += 10;
  data.meta.daemonPeers = { status: 'unavailable', observedAt: null };
  await stubApi(page, { [path]: data });
  await page.goto('/chain-health');
  const panel = page.locator('.dns-seeder-card');
  await expect(panel.getByText('LIVE PEER', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('REACHABILITY UNKNOWN', { exact: true })).toHaveCount(2);
  await expect(panel.locator('.badge.warning, .badge.error')).toHaveCount(0);
  await panel.getByText('Source times and coverage', { exact: true }).click();
  await expect(panel.getByText('DNS seeder: stale.', { exact: false })).toBeVisible();
  await expect(panel.getByText('Explorer daemon peers: unavailable.', { exact: false })).toBeVisible();
  await expect(panel.getByText('10 omitted', { exact: false })).toBeVisible();
});

test('a failed refresh removes cached live cues and rows @smoke', async ({ page }) => {
  await page.clock.install();
  await stubApi(page, { [path]: fixture() });
  await page.goto('/chain-health');
  const panel = page.locator('.dns-seeder-card');
  await expect(panel.getByText('LIVE PEER', { exact: true })).toHaveCount(1);
  await page.route(`**${path}?*`, route => route.fulfill({ status: 503, json: { success: false } }));
  await page.clock.fastForward(61_000);
  await page.clock.resume();
  await expect(panel.getByText('Failed to load DNS seeder snapshot.')).toBeVisible();
  await expect(panel.getByText('LIVE PEER', { exact: true })).toHaveCount(0);
  await expect(panel.locator('tbody tr')).toHaveCount(0);
  await expect(panel.getByText('0 live peers', { exact: true })).toBeVisible();
});

test('aging or future-dated peer evidence cannot keep a live cue @smoke', async ({ page }) => {
  await page.clock.install();
  const data = fixture();
  await stubApi(page, { [path]: data });
  await page.goto('/chain-health');
  const panel = page.locator('.dns-seeder-card');
  await expect(panel.getByText('LIVE PEER', { exact: true })).toHaveCount(1);
  await page.clock.fastForward(181_000);
  await page.clock.resume();
  await expect(panel.getByText('LIVE PEER', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('REACHABILITY UNKNOWN', { exact: true })).toHaveCount(2);
  await panel.getByText('Source times and coverage', { exact: true }).click();
  await expect(panel.getByText('Explorer daemon peers: expired.', { exact: false })).toBeVisible();
  const future = new Date(Date.now() + 300_000).toISOString();
  data.meta.daemonPeers.observedAt = future;
  data.data[0].livePeerObservedAt = future;
  await page.route(`**${path}?*`, route => route.fulfill({ json: data }));
  await page.reload();
  await expect(panel.getByText('LIVE PEER', { exact: true })).toHaveCount(0);
});

test('missing or contradictory provenance is unavailable instead of a live claim @smoke', async ({ page }) => {
  const data = fixture();
  data.meta.daemonPeers = { status: 'unavailable', observedAt: null };
  await stubApi(page, { [path]: data });
  await page.goto('/chain-health');
  const panel = page.locator('.dns-seeder-card');
  await expect(panel.getByText('Failed to load DNS seeder snapshot.')).toBeVisible();
  await expect(panel.getByText('LIVE PEER', { exact: true })).toHaveCount(0);
});

test('disabled and valid empty feeds have different empty states @smoke', async ({ page }) => {
  const data = fixture(0);
  data.meta.dnsSeeder.status = 'disabled';
  data.meta.dnsSeeder.fetchedAt = null;
  data.meta.dnsSeeder.lastAttemptAt = null;
  data.meta.daemonPeers = { status: 'not-requested', observedAt: null };
  await stubApi(page, { [path]: data });
  await page.goto('/chain-health');
  const panel = page.locator('.dns-seeder-card');
  await expect(panel.getByText('DNS seeder feed is disabled.', { exact: true })).toBeVisible();
  await page.route(`**${path}?*`, route => route.fulfill({ json: fixture(0) }));
  await page.reload();
  await expect(panel.getByText('No DNS seeder records are available.', { exact: true })).toBeVisible();
});
