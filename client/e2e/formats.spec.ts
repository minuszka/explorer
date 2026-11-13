import { expect, test } from '@playwright/test';
import type { DnsSeederNodesApiResponse } from '@defcon/shared';
import { stubApi } from './apiStub';

// A Hungarian browser in Budapest: its own conventions would print "2026. 09. 05. 14:00:00",
// "168 355" and "12,97". The site should show the same UTC times and English numbers to everyone.
test.use({ locale: 'hu-HU', timezoneId: 'Europe/Budapest' });

const BLOCK_TIME = 1_788_609_600; // 2026-09-05 12:00:00 UTC, 14:00 in Budapest.
const HASH = 'a'.repeat(64);

function block(height: number, time: number, difficulty = 400_000_000) {
  return {
    hash: HASH, height, confirmations: 3, size: 538, version: 0x20000000, merkleroot: 'b'.repeat(64),
    time, mediantime: time, nonce: 0, bits: '190a969d', difficulty, chainwork: '0', nTx: 0,
    rewardSat: 1_050_000_000_000, totalValueOutSat: 0, txids: [], reward: 10_500, totalValueOut: 0,
  };
}

test('a block time is shown in UTC whatever the browser language and time zone @smoke', async ({ page }) => {
  await stubApi(page, {
    '/api/block/123456': { success: true, data: block(123_456, BLOCK_TIME) },
    '/api/block/123456/txs': { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } },
  });

  await page.goto('/block/123456');
  const timestamp = page.locator('.detail-row').filter({ hasText: 'Timestamp' }).locator('.detail-value');
  await expect(timestamp).toContainText('2026-09-05 12:00:00 UTC');
  await expect(timestamp).not.toContainText('2026. 09. 05.');
});

test('node heights and uptimes use English separators, and a clock slightly ahead reads "just now" @smoke', async ({ page }) => {
  const now = Date.parse('2026-11-11T12:00:00.000Z');
  await page.clock.setFixedTime(now);
  const aheadOfBrowser = new Date(now + 1_500).toISOString();
  const dns: DnsSeederNodesApiResponse = {
    success: true,
    data: [{
      ip: '198.51.100.1', port: 8192, blockHeight: 168_355, snapshotBlockHeight: 168_350, bestBlockHash: HASH,
      isLivePeer: true, livePeerObservedAt: aheadOfBrowser, uptime2h: 12.97, lastSeen: aheadOfBrowser,
      walletVersion: '23.0.0', walletVersionSource: 'explorer-daemon', protocolVersion: 70242,
      protocolVersionSource: 'dns-seeder', peerCount: null,
    }],
    meta: {
      generatedAt: aheadOfBrowser,
      dnsSeeder: { status: 'ok', fetchedAt: aheadOfBrowser, lastAttemptAt: aheadOfBrowser, sourceObservedAt: null,
        completeness: 'unknown', receivedRows: 1, rejectedRows: 0, duplicateRows: 0, omittedRows: 0, returnedRows: 1, limit: 10_000 },
      daemonPeers: { status: 'ok', observedAt: aheadOfBrowser },
      portFailureEvidence: 'unavailable',
    },
  };
  await stubApi(page, {
    '/api/network/dns-seeder-nodes': dns,
    '/api/network/seed-nodes': { success: true, data: [1, 2].map((i) => ({ ip: `203.0.113.${i}`, label: `Seed ${i}`,
      reachable: true, fetchedAt: now, chainStatus: 'seed-baseline', blockHeight: 168_355, bestBlockHash: HASH })) },
  });

  await page.goto('/chain-health');
  // The row shows the crawler snapshot height here: a live-peer time ahead of the browser is not
  // taken as a live observation, and the source time comes from the seeder's last-seen value.
  const dnsRow = page.locator('.dns-seeder-card tbody tr').first();
  await expect(dnsRow).toContainText('168,350');
  await expect(dnsRow).toContainText('12.97%');
  await expect(dnsRow).toContainText('just now');
  await expect(page.locator('.dns-seeder-card')).not.toContainText('-1s ago');
  await expect(page.locator('main')).not.toContainText(/168\s35[05]|12,97/);
  await expect(page.getByText(/Seed baseline confirmed: 168,355/)).toBeVisible();
});

test('the rewards difficulty chart labels a two-hour window with UTC times of day @smoke', async ({ page }) => {
  // The page asks for the latest 50 blocks, newest first, 150 seconds apart.
  const blocks = Array.from({ length: 50 }, (_, i) => block(123_456 - i, BLOCK_TIME - i * 150, 400_000_000 + i * 1_000_000));
  await stubApi(page, { '/api/blocks/latest': { success: true, data: blocks } });

  await page.goto('/mining');
  await expect(page.getByRole('heading', { name: 'Difficulty, last 50 blocks' })).toBeVisible();
  const ticks = page.locator('.rewards-activity-card .recharts-xAxis .recharts-cartesian-axis-tick-value');
  await expect(ticks.first()).toBeVisible();
  const labels = await ticks.allTextContents();

  expect(labels.length).toBeGreaterThan(1);
  for (const label of labels) expect(label).toMatch(/^\d{2}:\d{2}$/);
  expect(new Set(labels).size).toBe(labels.length);
  // 12:00 UTC is the newest block; Budapest local time would be 14:00.
  expect(labels).toContain('12:00');
  expect(labels).not.toContain('14:00');
});

test('the dashboard hourly flow chart names its hours in UTC @smoke', async ({ page }) => {
  // The server sends the last 24 UTC hour buckets as "2026-09-05T12:00:00Z"; the newest is 12:00 UTC.
  const flow24h = Array.from({ length: 24 }, (_, i) => ({
    hour: new Date((BLOCK_TIME - (23 - i) * 3600) * 1000).toISOString().slice(0, 13) + ':00:00Z',
    blocks: 24,
    txs: i,
  }));
  await stubApi(page, {
    '/api/dashboard/overview': { success: true, data: { stats: { flow24h }, blocks: [], txs: [] } },
  });

  await page.goto('/');
  // Budapest local time would read "15:00 - 14:00".
  const legend = page.locator('.flow-legend');
  await expect(legend).toContainText('13:00 - 12:00 UTC');
  await expect(legend).not.toContainText(/15:00|14:00/);
  await expect(page.locator('.flow-bar-item')).toHaveCount(24);
  await expect(page.locator('.flow-bar-item').last()).toHaveAttribute('title', /^12:00 UTC \| 24 blocks \| 23 txs$/);
});
