import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './apiStub';

// The Masternodes table: every active node in one table with search, a status filter, sortable
// columns and 50-row pages, all kept in the URL; versions matched by registration, never by IP.

const COUNT = 121; // node 121 is POSE_BANNED, so 120 active nodes: pages of 50, 50 and 20.
const ip = (i: number) => `203.0.113.${i}`;
const proTx = (i: number) => i.toString(16).padStart(64, 'a');
const payout = (i: number) => `D${String(i).padStart(33, 'P')}`;

function node(i: number) {
  const status = i === COUNT ? 'POSE_BANNED' : i % 10 === 0 ? 'POSE_PENALTY' : 'ENABLED';
  return {
    id: `node-${i}`, service: `${ip(i)}:9999`, ip: ip(i), port: 9999, status, protocol: 70242, lastSeen: null, activeSeconds: null,
    isTor: false, countryCode: i % 2 ? 'DE' : 'US', countryName: i % 2 ? 'Germany' : 'United States',
    // Node 7 has no proTxHash: it is matched to its version by id.
    proTxHash: i === 7 ? null : proTx(i), ownerAddress: null, payoutAddress: payout(i), collateralAddress: null,
    registeredHeight: null, registeredAt: null, poseBanHeight: null, poseBanAt: null, collateralAmount: null,
    provider: i % 2 ? 'Hetzner' : 'Contabo', providerSource: i % 4 === 0 ? 'tag' : 'mmdb', providerTagCidr: null,
    providerTagSource: null, providerConfidence: null, providerEvidenceUrl: null, asn: null, asnOrg: null,
  };
}

// Versions: i % 3 === 0 → 23.0.0, i % 3 === 1 → 22.1.3, i % 3 === 2 → none reported.
function versionRow(i: number) {
  const walletVersion = i % 3 === 0 ? '23.0.0' : i % 3 === 1 ? '22.1.3' : null;
  return {
    id: i === 7 ? 'node-7' : proTx(i), ip: ip(i), port: 9999, status: i % 10 === 0 ? 'POSE_PENALTY' : 'ENABLED',
    walletVersion, versionState: walletVersion ? (i === 4 ? 'stale' : 'fresh') : 'unknown',
    lastVersionObservedAt: null, lastInventoryObservedAt: null, sources: [], isDeprecated: false,
  };
}

const nodes = Array.from({ length: COUNT }, (_, index) => node(index + 1));
const versions = Array.from({ length: COUNT - 1 }, (_, index) => versionRow(index + 1));
// A retained record for node 2's address under another registration must not lend node 2 its version.
versions.push({ ...versionRow(3), id: proTx(999), ip: ip(2), walletVersion: '99.0.0', versionState: 'fresh' });

function api() {
  return {
    '/api/masternodes/summary': { success: true, data: { total: COUNT, enabled: 108, poseBanned: 1, posePenalty: 12, countries: 2 } },
    '/api/masternodes/distribution': { success: true, data: { total: 120, countries: [], providers: [] } },
    '/api/masternodes': { success: true, data: { nodes, total: COUNT } },
    '/api/v1/node-inventory/active-versions': { success: true, data: { nodes: versions } },
  };
}

const rows = (page: Page) => page.locator('.mn-table tbody tr');
const rowFor = (page: Page, i: number) => rows(page).filter({ hasText: `${ip(i)}:9999` });
const fitsWindow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('the table lists the active nodes with their versions, 50 per page, and keeps the page in the URL @smoke', async ({ page }, testInfo) => {
  await stubApi(page, api());
  await page.goto('/masternodes');

  await expect(rows(page)).toHaveCount(50);
  await expect(page.getByText('Page 1 of 3')).toBeVisible();
  await expect(page.locator('.mn-table-card .mn-panel-metric')).toHaveText('120 nodes');
  // Sorted by address: 203.0.113.1 first, the banned node nowhere.
  await expect(rows(page).first()).toContainText(`${ip(1)}:9999`);
  await expect(rowFor(page, 1).locator('.mn-col-version')).toContainText('22.1.3');
  await expect(rowFor(page, 3).locator('.mn-col-version')).toContainText('23.0.0');
  await expect(rowFor(page, 4).locator('.mn-col-version')).toContainText('stale');
  await expect(rowFor(page, 7).locator('.mn-col-version')).toContainText('22.1.3');
  // Node 2 reported no version; the retained 99.0.0 at its address belongs to another registration.
  await expect(rowFor(page, 2).locator('.mn-col-version')).toHaveText('unknown');
  await expect(rowFor(page, 1).locator('.mn-col-payout a')).toHaveAttribute('href', `/address/${payout(1)}`);
  if (testInfo.project.name.includes('mobile')) {
    // On a phone each row is a card: the address and status on top, the version starting a second line.
    const [service, version] = await Promise.all([
      rowFor(page, 1).locator('.mn-col-service').boundingBox(),
      rowFor(page, 1).locator('.mn-col-version').boundingBox(),
    ]);
    expect(version!.y).toBeGreaterThan(service!.y + service!.height - 1);
    expect(Math.abs(version!.x - service!.x)).toBeLessThanOrEqual(2);
  }

  await page.getByRole('navigation', { name: 'Masternode pages' }).getByRole('button', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/[?&]page=2(&|$)/);
  await page.reload();
  await expect(page.getByText('Page 2 of 3')).toBeVisible();
  await expect(rows(page).first()).toContainText(`${ip(51)}:9999`);
  expect(await fitsWindow(page)).toBe(true);
});

test('the search narrows by address and by payout address @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.goto('/masternodes');
  const search = page.getByLabel('Search masternodes');

  await search.fill(`${ip(17)}:9999`);
  await expect(rows(page)).toHaveCount(1);
  await expect(page).toHaveURL(/[?&]q=/);

  await search.fill(payout(42));
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(`${ip(42)}:9999`);

  // The banned node is not in the table at all.
  await search.fill(`${ip(COUNT)}:9999`);
  await expect(page.getByText('No masternodes match')).toBeVisible();
});

test('the status filter and the sort order survive a reload @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.goto('/masternodes');

  await page.getByRole('group', { name: 'Status' }).getByRole('button', { name: /PoSe Penalty/ }).click();
  await expect(rows(page)).toHaveCount(12);
  const version = page.getByRole('columnheader', { name: 'Version' });
  await version.getByRole('button').click();
  await expect(page).toHaveURL(/[?&]sort=version(&|$)/);
  // Lowest version first, and the nodes without one still last.
  await expect(rows(page).first().locator('.mn-col-version')).toContainText('22.1.3');
  await expect(rows(page).last().locator('.mn-col-version')).toHaveText('unknown');
  await version.getByRole('button').click();
  await expect(page).toHaveURL(/[?&]sort=-version(&|$)/);

  await page.reload();
  await expect(page.getByRole('group', { name: 'Status' }).getByRole('button', { name: /PoSe Penalty/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('columnheader', { name: 'Version' })).toHaveAttribute('aria-sort', 'descending');
  await expect(rows(page)).toHaveCount(12);
  // Highest version first; nodes without a version come last in either direction.
  await expect(rows(page).first().locator('.mn-col-version')).toContainText('23.0.0');
  await expect(rows(page).last().locator('.mn-col-version')).toHaveText('unknown');
});

test('on a wide screen the column headers stay in view below the site header @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'On a phone the headers are a row of sort buttons above the cards.');
  await stubApi(page, api());
  await page.goto('/masternodes');
  await expect(rows(page)).toHaveCount(50);

  // No inner scroll box: the page itself scrolls, and the header row sticks under the site header.
  const wrap = page.locator('.mn-table-wrap');
  expect(await wrap.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await rows(page).nth(40).scrollIntoViewIfNeeded();
  const [siteHeader, columnHeader] = await Promise.all([
    page.locator('header.header').boundingBox(),
    page.getByRole('columnheader', { name: 'Service' }).boundingBox(),
  ]);
  expect(Math.abs(columnHeader!.y - (siteHeader!.y + siteHeader!.height))).toBeLessThanOrEqual(2);
});

test('at tablet widths the table never runs past its card @smoke', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'Sets its own window widths; one project is enough.');
  await stubApi(page, api());
  // Below about 900 px the six columns do not fit, so rows turn into cards there.
  for (const width of [700, 744, 820, 900, 901, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/masternodes');
    await expect(rows(page)).toHaveCount(50);
    await page.evaluate(async () => { await document.fonts.ready; });
    const fits = await page.evaluate(() => {
      const wrap = document.querySelector('.mn-table-wrap')!.getBoundingClientRect();
      const table = document.querySelector('.mn-table')!.getBoundingClientRect();
      return table.right <= wrap.right + 1;
    });
    expect(fits, `table inside its card at ${width} px`).toBe(true);
  }
});

test('versions still loading show as pending, not unknown @smoke', async ({ page }) => {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await stubApi(page, api());
  await page.route('**/api/v1/node-inventory/active-versions', async (route) => {
    await released;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { nodes: versions } }) });
  });
  await page.goto('/masternodes');

  await expect(rows(page)).toHaveCount(50);
  await expect(rowFor(page, 1).locator('.mn-col-version')).toHaveText('…');
  await expect(rows(page).locator('.mn-col-version').filter({ hasText: 'unknown' })).toHaveCount(0);
  release();
  await expect(rowFor(page, 1).locator('.mn-col-version')).toContainText('22.1.3');
  await expect(rowFor(page, 2).locator('.mn-col-version')).toHaveText('unknown');
});

test('bad values in the address fall back to defaults, and the status counts add up @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.goto('/masternodes?page=99&sort=junk&status=zzz');

  // Page 99 shows the last page; an unknown sort and status fall back to address order and All.
  await expect(page.getByText('Page 3 of 3')).toBeVisible();
  await expect(rows(page)).toHaveCount(20);
  await expect(page.getByRole('columnheader', { name: 'Service' })).toHaveAttribute('aria-sort', 'ascending');
  const status = page.getByRole('group', { name: 'Status' });
  await expect(status.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(status.locator('.filter-chip-count')).toHaveText(['120', '108', '12']);

  await status.getByRole('button', { name: /^Enabled/ }).click();
  await expect(page.locator('.mn-table-card .mn-panel-metric')).toHaveText('108 of 120');
  await expect(rows(page).locator('.badge.warning')).toHaveCount(0);
});

test('a search with no match says so and offers a way back @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.goto('/masternodes?q=nothing-matches-this');

  await expect(page.getByText('No masternodes match')).toBeVisible();
  await expect(page.locator('.mn-table')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear search and filter' }).click();
  await expect(rows(page)).toHaveCount(50);
  await expect(page).not.toHaveURL(/[?&]q=/);
});

test('without a version snapshot every version is unknown and the page says why @smoke', async ({ page }) => {
  await stubApi(page, api());
  // Registered after the stub, so it answers first: the version endpoint fails.
  await page.route('**/api/v1/node-inventory/active-versions', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false }) }));
  await page.goto('/masternodes');

  await expect(rows(page)).toHaveCount(50);
  await expect(page.getByText('Versions are unavailable right now')).toBeVisible();
  await expect(rows(page).locator('.mn-col-version').filter({ hasNotText: 'unknown' })).toHaveCount(0);
});

test('a star marks a node, My nodes shows only starred ones after a reload, and the address opens its page @smoke', async ({ page }, testInfo) => {
  await stubApi(page, api());
  // Node 121 is banned, so it is starred but not in the active table.
  await page.addInitScript(([key, value]) => {
    if (!window.sessionStorage.getItem('seeded')) {
      window.localStorage.setItem(key, value);
      window.sessionStorage.setItem('seeded', '1');
    }
  }, ['deftrack-fav-masternodes', JSON.stringify([proTx(121)])]);
  await page.goto('/masternodes');
  await expect(rows(page)).toHaveCount(50);

  const starButton = (i: number) => rowFor(page, i).getByRole('button', { name: `Star ${ip(i)}:9999` });
  await expect(rowFor(page, 1).locator('.mn-col-service a')).toHaveAttribute('href', `/masternode/${proTx(1)}`);
  // Node 7 has no proTxHash: no star and no page link.
  await expect(rowFor(page, 7).getByRole('button', { name: /^Star / })).toHaveCount(0);
  await expect(rowFor(page, 7).locator('.mn-col-service a')).toHaveCount(0);
  if (testInfo.project.name.includes('mobile')) {
    // In the card view the star ends the first line inside the card, even beside the widest badge.
    const [card, starBox, serviceBox] = await Promise.all([
      rowFor(page, 10).boundingBox(),
      starButton(10).boundingBox(),
      rowFor(page, 10).locator('.mn-col-service').boundingBox(),
    ]);
    expect(starBox!.x + starBox!.width).toBeLessThanOrEqual(card!.x + card!.width);
    expect(starBox!.y).toBeLessThan(serviceBox!.y + serviceBox!.height);
  }

  await starButton(1).click();
  await starButton(3).click();
  await expect(starButton(1)).toHaveAttribute('aria-pressed', 'true');
  const mine = page.getByRole('button', { name: /My nodes/ });
  await expect(mine).toContainText('3');
  await mine.click();
  await expect(page).toHaveURL(/[?&]mine=1(&|$)/);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('.mn-starred-elsewhere a')).toHaveAttribute('href', `/masternode/${proTx(121)}`);

  await page.reload();
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(2);
  await expect(starButton(3)).toHaveAttribute('aria-pressed', 'true');
  expect(await fitsWindow(page)).toBe(true);

  await rowFor(page, 1).locator('.mn-col-service a').click();
  await expect(page).toHaveURL(new RegExp(`/masternode/${proTx(1)}$`));
});

test('a starred node hidden by the country filter is not called inactive; a banned one still is @smoke', async ({ page }) => {
  // Node 2 is in the United States and active; the Germany filter hides it. Node 121 is banned.
  await stubApi(page, {
    ...api(),
    '/api/masternodes/distribution': { success: true, data: { total: 120, countries: [
      { countryCode: 'DE', countryName: 'Germany', count: 61 }, { countryCode: 'US', countryName: 'United States', count: 60 },
    ], providers: [] } },
  });
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), ['deftrack-fav-masternodes', JSON.stringify([proTx(2), proTx(121)])]);
  await page.goto('/masternodes?mine=1');
  await expect(rows(page)).toHaveCount(1);
  const elsewhere = page.locator('.mn-starred-elsewhere a');
  await expect(elsewhere).toHaveCount(1);
  await expect(elsewhere).toHaveAttribute('href', `/masternode/${proTx(121)}`);
  await page.getByRole('list', { name: 'Masternodes by country' }).getByRole('button', { name: /Germany/ }).click();
  await expect(page.getByText('No starred masternode matches the chosen country or provider')).toBeVisible();
  await expect(page.getByText('None of your starred masternodes is active')).toHaveCount(0);
  // Still only the banned node is listed as not active: node 2 is merely filtered out.
  await expect(elsewhere).toHaveCount(1);
  await expect(elsewhere).toHaveAttribute('href', `/masternode/${proTx(121)}`);
});

test('My nodes with only a banned star says none of them is active and links to it @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), ['deftrack-fav-masternodes', JSON.stringify([proTx(121)])]);
  await page.goto('/masternodes?mine=1');
  await expect(page.getByText('None of your starred masternodes is active')).toBeVisible();
  await expect(page.locator('.mn-starred-elsewhere a')).toHaveAttribute('href', `/masternode/${proTx(121)}`);
  await expect(rows(page)).toHaveCount(0);
});

test('with storage blocked the table says the stars are not kept @smoke', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });
  });
  await stubApi(page, api());
  await page.goto('/masternodes');
  await rowFor(page, 1).getByRole('button', { name: `Star ${ip(1)}:9999` }).click();
  await expect(page.getByText('This browser does not allow saving here, so your stars are kept only until the page is reloaded or closed.')).toBeVisible();
});

test('My nodes without any star explains how to add one @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.goto('/masternodes?mine=1');
  await expect(page.getByText('No starred masternodes yet')).toBeVisible();
  await page.getByRole('button', { name: 'Show all masternodes' }).click();
  await expect(page).not.toHaveURL(/mine=/);
  await expect(rows(page)).toHaveCount(50);
});
