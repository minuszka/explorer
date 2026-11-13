import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './apiStub';

// The Masternodes page's country and provider rankings (plain HTML lists instead of charts), the
// version filter in the table's URL, and the Network page's version rows that open that table.

// Active nodes per country, largest first: the eight largest get a row each, CA and JP share "Others".
const COUNTRIES: Array<[code: string, name: string, count: number]> = [
  ['DE', 'Germany', 9], ['US', 'United States', 7], ['FR', 'France', 6], ['NL', 'Netherlands', 5],
  ['FI', 'Finland', 4], ['GB', 'United Kingdom', 3], ['PL', 'Poland', 2], ['SG', 'Singapore', 2],
  ['CA', 'Canada', 1], ['JP', 'Japan', 1],
];
// Active nodes per provider, largest first, with how many sit in tagged address ranges. Only the ten
// largest are listed, so Scaleway is not.
const PROVIDERS: Array<[name: string, count: number, tagged: number]> = [
  ['Hetzner', 8, 3], ['Contabo', 7, 0], ['OVH', 5, 5], ['DigitalOcean', 4, 1], ['Vultr', 4, 0],
  ['Linode', 3, 0], ['AWS', 3, 2], ['Google Cloud', 2, 0], ['Azure', 2, 0], ['Netcup', 1, 0], ['Scaleway', 1, 0],
];
const ACTIVE = 40;
const BANNED = ACTIVE + 1; // a POSE_BANNED node in Canada: in no ranking and no table row.

const ip = (i: number) => `198.51.100.${i}`;
const proTx = (i: number) => i.toString(16).padStart(64, 'b');
// Versions: i % 3 === 0 → 23.0.0, i % 3 === 1 → 22.1.4, i % 3 === 2 → none reported.
const versionOf = (i: number) => (i % 3 === 0 ? '23.0.0' : i % 3 === 1 ? '22.1.4' : null);
const BY_VERSION = { '23.0.0': 13, '22.1.4': 14, unknown: 13 };

function expand<T>(groups: Array<[T, number]>): T[] {
  return groups.flatMap(([value, count]) => Array.from({ length: count }, () => value));
}
const countryOf = expand(COUNTRIES.map(([code, name, count]) => [{ code, name }, count] as [{ code: string; name: string }, number]));
const providerOf = expand(PROVIDERS.map(([name, count, tagged]) => [{ name, tagged }, count] as [{ name: string; tagged: number }, number]));

function node(i: number) {
  const country = i === BANNED ? { code: 'CA', name: 'Canada' } : countryOf[i - 1];
  const provider = i === BANNED ? { name: 'Hetzner', tagged: 0 } : providerOf[i - 1];
  // The first `tagged` nodes of each provider sit in a tagged range.
  const nth = providerOf.slice(0, i - 1).filter((entry) => entry.name === provider.name).length;
  return {
    id: `node-${i}`, service: `${ip(i)}:9999`, ip: ip(i), port: 9999,
    status: i === BANNED ? 'POSE_BANNED' : i % 10 === 0 ? 'POSE_PENALTY' : 'ENABLED',
    protocol: 70242, lastSeen: null, activeSeconds: null, isTor: false,
    countryCode: country.code, countryName: country.name,
    proTxHash: proTx(i), ownerAddress: null, payoutAddress: `D${String(i).padStart(33, 'Q')}`, collateralAddress: null,
    registeredHeight: null, registeredAt: null, poseBanHeight: null, poseBanAt: null, collateralAmount: null,
    provider: provider.name, providerSource: nth < provider.tagged ? 'tag' : 'mmdb', providerTagCidr: null,
    providerTagSource: null, providerConfidence: null, providerEvidenceUrl: null, asn: null, asnOrg: null,
  };
}

const nodes = Array.from({ length: BANNED }, (_, index) => node(index + 1));

function versionSnapshot() {
  const now = new Date().toISOString();
  return {
    generatedAt: now, statusObservedAt: now, inventoryPollSeconds: 300, versionMaxAgeSeconds: 86400, requiredVersion: '23.0.0',
    summary: { total: ACTIVE, enabled: 36, posePenalty: 4, fresh: 27, stale: 0, unknown: BY_VERSION.unknown,
      coveragePct: 67.5, recommended: BY_VERSION['23.0.0'], deprecated: BY_VERSION['22.1.4'] },
    versions: [
      { version: '23.0.0', count: BY_VERSION['23.0.0'], sharePct: 32.5, isDeprecated: false },
      { version: '22.1.4', count: BY_VERSION['22.1.4'], sharePct: 35, isDeprecated: true },
    ],
    nodes: Array.from({ length: ACTIVE }, (_, index) => {
      const i = index + 1;
      const walletVersion = versionOf(i);
      return {
        id: proTx(i), ip: ip(i), port: 9999, status: i % 10 === 0 ? 'POSE_PENALTY' : 'ENABLED',
        walletVersion, versionState: walletVersion ? 'fresh' : 'unknown', isDeprecated: walletVersion === '22.1.4',
        lastVersionObservedAt: walletVersion ? now : null, lastInventoryObservedAt: now, sources: ['Direct peer'],
      };
    }),
  };
}

function api() {
  return {
    '/api/masternodes/summary': { success: true, data: {
      snapshotId: 's1', observedAt: new Date().toISOString(), total: BANNED, enabled: 36, poseBanned: 1, posePenalty: 4,
      countries: COUNTRIES.length, tagged: 11, taggedCoveragePct: 27.5, enabledPct: 87.8,
      topCountry: { countryCode: 'DE', countryName: 'Germany', count: 9 }, topProvider: { provider: 'Hetzner', count: 8, tagged: 3, auto: 5 },
    } },
    '/api/masternodes/distribution': { success: true, data: {
      snapshotId: 's1', observedAt: new Date().toISOString(), total: ACTIVE,
      countries: COUNTRIES.map(([countryCode, countryName, count]) => ({ countryCode, countryName, count })),
      providers: PROVIDERS.map(([provider, count, tagged]) =>
        // DigitalOcean comes without an auto count: the page works it out as count − tagged.
        (provider === 'DigitalOcean' ? { provider, count, tagged } : { provider, count, tagged, auto: count - tagged })),
    } },
    '/api/masternodes': { success: true, data: { nodes, total: BANNED } },
    '/api/v1/node-inventory/active-versions': { success: true, data: versionSnapshot() },
    '/api/network': { success: true, data: { connections: 1, protocolversion: 70242, blockHeight: 100,
      peers: [{ addr: '203.0.113.1:8192', subver: '/DeFCoN:23.0.0/', synced_blocks: 100, synced_headers: 100, inbound: false }] } },
  };
}

const countryList = (page: Page) => page.getByRole('list', { name: 'Masternodes by country' });
const providerList = (page: Page) => page.getByRole('list', { name: 'Masternodes by hosting provider' });
const tableRows = (page: Page) => page.locator('.mn-table tbody tr');
const tableMetric = (page: Page) => page.locator('.mn-table-card .mn-panel-metric');
const fitsWindow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('countries are ranked with their count and share, the rest under Others, and a row filters the table @smoke', async ({ page }, testInfo) => {
  await stubApi(page, api());
  await page.goto('/masternodes');

  const rows = countryList(page).getByRole('button');
  await expect(rows).toHaveCount(9);
  await expect(rows.locator('.mn-rank-name')).toHaveText([
    'Germany', 'United States', 'France', 'Netherlands', 'Finland', 'United Kingdom', 'Poland', 'Singapore', 'Others',
  ]);
  // Count and share of all 40 active nodes; Canada and Japan are only inside Others.
  await expect(rows.first().locator('.mn-rank-value strong')).toHaveText('9');
  await expect(rows.first().locator('.mn-rank-value .text-muted')).toHaveText('22.5%');
  await expect(rows.last().locator('.mn-rank-value strong')).toHaveText('2');
  await expect(rows.last().locator('.mn-rank-value .text-muted')).toHaveText('5.0%');
  await expect(countryList(page)).not.toContainText('Canada');
  // The bar is as long as the share.
  expect(await rows.first().locator('.mn-rank-fill').evaluate((element) => (element as HTMLElement).style.width)).toBe('22.5%');
  await expect(countryList(page).locator('button[aria-pressed="true"]')).toHaveCount(0);
  await expect(tableRows(page)).toHaveCount(ACTIVE);
  await page.screenshot({ path: testInfo.outputPath('masternode-rankings.png'), fullPage: true });
  expect(await fitsWindow(page)).toBe(true);

  await rows.first().click();
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.mn-table-card').getByText('Country: Germany', { exact: true })).toBeVisible();
  await expect(tableRows(page)).toHaveCount(9);
  await expect(tableMetric(page)).toHaveText('9 nodes');

  // Others is every active node outside the eight listed countries: Canada and Japan, not the banned node.
  await rows.last().click();
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'false');
  await expect(rows.last()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.mn-table-card').getByText('Country: Others', { exact: true })).toBeVisible();
  await expect(tableRows(page)).toHaveCount(2);
  await expect(tableRows(page).filter({ hasText: 'Canada' })).toHaveCount(1);
  await expect(tableRows(page).filter({ hasText: 'Japan' })).toHaveCount(1);

  // Pressing the active row again clears the filter.
  await rows.last().click();
  await expect(rows.last()).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.mn-table-card').getByText(/^Country:/)).toHaveCount(0);
  await expect(tableRows(page)).toHaveCount(ACTIVE);
});

test('the ten largest providers are named with an auto/tagged split and a legend, and a row filters the table @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.goto('/masternodes');

  const legend = page.getByRole('list', { name: 'Legend' });
  await expect(legend.getByRole('listitem')).toHaveText(['Auto detected', 'Tagged address ranges']);
  await expect(page.locator('.mn-panel-card .mn-panel-metric').filter({ hasText: 'largest providers' })).toHaveText('10 largest providers');

  const rows = providerList(page).getByRole('button');
  await expect(rows.locator('.mn-rank-name')).toHaveText(PROVIDERS.slice(0, 10).map(([name]) => name));
  await expect(providerList(page)).not.toContainText('Scaleway');

  // Hetzner: 8 nodes, 3 in tagged ranges; the largest provider fills the track, split 5 : 3.
  const hetzner = rows.filter({ hasText: 'Hetzner' });
  await expect(hetzner.locator('.mn-rank-value strong')).toHaveText('8');
  await expect(hetzner.locator('.mn-rank-value .text-muted')).toHaveText('3 tagged');
  await expect(hetzner).toHaveAttribute('title', 'Hetzner: 5 auto detected, 3 in tagged ranges');
  const widths = (row: typeof hetzner) =>
    row.evaluate((element) => ['.mn-rank-stack', '.mn-rank-fill.auto', '.mn-rank-fill.tagged']
      .map((selector) => (element.querySelector(selector) as HTMLElement).style.width));
  expect(await widths(hetzner)).toEqual(['100%', '62.5%', '37.5%']);
  // OVH is all tagged, at 5 / 8 of the largest bar.
  expect(await widths(rows.filter({ hasText: 'OVH' }))).toEqual(['62.5%', '0%', '100%']);
  // DigitalOcean's auto count is missing from the response: 4 nodes, 1 tagged, so 3 auto detected.
  const digitalOcean = rows.filter({ hasText: 'DigitalOcean' });
  await expect(digitalOcean).toHaveAttribute('title', 'DigitalOcean: 3 auto detected, 1 in tagged ranges');
  expect(await widths(digitalOcean)).toEqual(['50%', '75%', '25%']);

  await hetzner.click();
  await expect(hetzner).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.mn-table-card').getByText('Provider: Hetzner', { exact: true })).toBeVisible();
  // The banned Hetzner node is not counted.
  await expect(tableRows(page)).toHaveCount(8);
  await page.locator('.mn-table-card').getByRole('button', { name: 'Show all' }).click();
  await expect(hetzner).toHaveAttribute('aria-pressed', 'false');
  await expect(tableRows(page)).toHaveCount(ACTIVE);
});

test('the version in the address filters the table, unknown means no version, and the filter can be cleared @smoke', async ({ page }) => {
  await stubApi(page, api());
  const versions = () => tableRows(page).locator('.mn-col-version');

  await page.goto('/masternodes?version=23.0.0');
  await expect(tableRows(page)).toHaveCount(BY_VERSION['23.0.0']);
  await expect(versions().filter({ hasNotText: '23.0.0' })).toHaveCount(0);
  await expect(page.locator('.mn-table-card').getByText('Version: 23.0.0', { exact: true })).toBeVisible();
  await expect(tableMetric(page)).toHaveText(`${BY_VERSION['23.0.0']} of ${ACTIVE}`);
  // The status counts are counted within the version: node 30 is the one 23.0.0 node with PoSe points.
  await expect(page.getByRole('group', { name: 'Status' }).locator('.filter-chip-count')).toHaveText(['13', '12', '1']);

  // The version filter and a country row narrow together: Germany is nodes 1-9, so nodes 3, 6 and 9.
  await countryList(page).getByRole('button', { name: /Germany/ }).click();
  await expect(tableRows(page)).toHaveCount(3);
  await page.locator('.mn-table-card').getByRole('button', { name: 'Show all' }).click();

  await page.getByRole('button', { name: 'Clear version filter' }).click();
  await expect(page).not.toHaveURL(/[?&]version=/);
  await expect(tableRows(page)).toHaveCount(ACTIVE);
  await expect(page.locator('.mn-table-card').getByText(/^Version:/)).toHaveCount(0);

  await page.goto('/masternodes?version=unknown');
  await expect(tableRows(page)).toHaveCount(BY_VERSION.unknown);
  await expect(versions().filter({ hasNotText: /^unknown$/ })).toHaveCount(0);
  await expect(page.locator('.mn-table-card').getByText('Version: unknown', { exact: true })).toBeVisible();

  // Spaces around the version in the address are ignored.
  await page.goto('/masternodes?version=%2023.0.0%20');
  await expect(tableRows(page)).toHaveCount(BY_VERSION['23.0.0']);
  await expect(page.locator('.mn-table-card').getByText('Version: 23.0.0', { exact: true })).toBeVisible();

  // A version no node runs: the empty state's button clears the version filter too.
  await page.goto('/masternodes?version=1.0.0');
  await expect(page.getByText('No masternodes match')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search and filter' }).click();
  await expect(tableRows(page)).toHaveCount(ACTIVE);
  await expect(page).not.toHaveURL(/[?&]version=/);
});

test('while the versions load, a version filter waits instead of showing a false result @smoke', async ({ page }) => {
  for (const [version, count] of [['23.0.0', BY_VERSION['23.0.0']], ['unknown', BY_VERSION.unknown]] as const) {
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubApi(page, api());
    // Registered after the stub, so it answers first: the versions arrive only on release().
    await page.route('**/api/v1/node-inventory/active-versions', async (route) => {
      await released;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: versionSnapshot() }) });
    });
    await page.goto(`/masternodes?version=${version}`);

    // The node list is in, the versions are not: no "no match" for 23.0.0, no "all of them" for unknown.
    await expect(page.locator('.mn-table-card').getByText('Loading versions...')).toBeVisible();
    await expect(tableRows(page)).toHaveCount(0);
    await expect(page.getByText('No masternodes match')).toHaveCount(0);
    await expect(tableMetric(page)).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Status' }).locator('.filter-chip-count')).toHaveText(['0', '0', '0']);
    release();
    await expect(tableRows(page)).toHaveCount(count);
    await expect(page.locator('.mn-table-card').getByText('Loading versions...')).toHaveCount(0);
  }
});

test('a version row on the Network page opens the Masternodes table filtered to that version @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.goto('/network');

  const versionRows = page.locator('.network-version-row');
  await expect(versionRows).toHaveCount(3);
  await versionRows.filter({ hasText: '23.0.0' }).click();
  await expect(page).toHaveURL(/\/masternodes\?version=23\.0\.0$/);
  await expect(tableRows(page)).toHaveCount(BY_VERSION['23.0.0']);
  await expect(page.locator('.mn-table-card').getByText('Version: 23.0.0', { exact: true })).toBeVisible();
  // The table, not the top of the page, is in view: its heading sits just below the site header.
  const headerBottom = await page.locator('header.header').evaluate((element) => element.getBoundingClientRect().bottom);
  const tableHeading = page.getByRole('heading', { name: 'Active Masternodes' });
  await expect.poll(async () => {
    const box = await tableHeading.boundingBox();
    return box != null && box.y >= headerBottom - 1 && box.y < headerBottom + 120;
  }).toBe(true);

  await page.goBack();
  await page.getByRole('link', { name: /Unknown version/ }).click();
  await expect(page).toHaveURL(/\/masternodes\?version=unknown$/);
  await expect(tableRows(page)).toHaveCount(BY_VERSION.unknown);
  await expect(tableRows(page).locator('.mn-col-version').filter({ hasNotText: /^unknown$/ })).toHaveCount(0);

  await page.goBack();
  await page.getByRole('link', { name: 'Open the Masternodes table' }).click();
  await expect(page).toHaveURL(/\/masternodes$/);
  await expect(tableRows(page)).toHaveCount(ACTIVE);
});
