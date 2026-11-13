import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './apiStub';

// One masternode's page: identity, addresses, placement, version and the PoSe history of this
// registration (not of earlier registrations of the same collateral), plus the "My nodes" star.

const proTx = 'ab'.repeat(32);
const otherProTx = 'ef'.repeat(32);
const nodeId = `${'cd'.repeat(32)}-1`;
const service = '203.0.113.50:9999';
const registeredAt = Date.UTC(2026, 0, 15) / 1000;
const FAVORITES_KEY = 'deftrack-fav-masternodes';

const detail = {
  id: nodeId, service, ip: '203.0.113.50', port: 9999, status: 'POSE_PENALTY', protocol: 70242, lastSeen: null,
  activeSeconds: 3_600, isTor: false, countryCode: 'DE', countryName: 'Germany', proTxHash: proTx,
  ownerAddress: 'DOwnerAddress000000000000000000000', payoutAddress: 'DPayoutAddress00000000000000000000',
  collateralAddress: 'DCollateralAddress0000000000000000', registeredHeight: 120_000, registeredAt,
  poseBanHeight: null, poseBanAt: null, poseRevivedHeight: 125_000, posePenalty: 33, operatorPubkey: 'op'.repeat(24),
  votingAddress: 'DVotingAddress00000000000000000000', collateralAmount: 10_000, provider: 'Hetzner',
  providerSource: 'tag', providerTagCidr: '203.0.113.0/24', providerTagSource: 'manual', providerConfidence: 1,
  providerEvidenceUrl: null, asn: 24_940, asnOrg: 'Hetzner Online GmbH', uptime: 3_600, queuePosition: 5, nextPayoutEta: 600,
};

const events = [
  // Newest first, as the endpoint answers. A plain status change after this registration: shown.
  { _id: 'e1', nodeId, service, previousStatus: 'ENABLED', currentStatus: 'POSE_PENALTY', detectedAt: '2026-11-10T08:00:00.000Z', eventType: 'status', eventStatus: 'observed', proTxHash: null },
  // A ban of this registration that later recovered: shown.
  { _id: 'e2', nodeId, service, previousStatus: 'POSE_BAN_HEIGHT', currentStatus: 'POSE_BANNED', detectedAt: '2026-11-01T08:00:00.000Z', eventType: 'ban', eventStatus: 'recovered', proTxHash: proTx, poseBanHeight: 124_000, detectedHeight: 124_000, recoveredAt: '2026-11-02T08:00:00.000Z', recoveredHeight: 125_000 },
  // A ban of an earlier registration of the same collateral: not shown.
  { _id: 'e3', nodeId, service, previousStatus: 'POSE_BAN_HEIGHT', currentStatus: 'POSE_BANNED', detectedAt: '2026-10-01T08:00:00.000Z', eventType: 'ban', eventStatus: 'banned', proTxHash: otherProTx, poseBanHeight: 110_000 },
  // A plain status change from before this registration: cannot be tied to it, not shown.
  { _id: 'e4', nodeId, service, previousStatus: 'NEW', currentStatus: 'ENABLED', detectedAt: '2025-12-01T08:00:00.000Z', eventType: 'status', eventStatus: 'observed', proTxHash: null },
];

const versions = { nodes: [{ id: proTx, ip: '203.0.113.50', port: 9999, status: 'POSE_PENALTY', walletVersion: '23.0.0', versionState: 'fresh', lastVersionObservedAt: null, lastInventoryObservedAt: null, sources: [], isDeprecated: false }] };

function api(overrides: Record<string, Record<string, unknown>> = {}) {
  return {
    [`/api/v1/masternodes/${proTx}`]: { success: true, data: detail },
    [`/api/v1/masternodes/${nodeId}/events`]: { success: true, data: events },
    '/api/v1/node-inventory/active-versions': { success: true, data: versions },
    ...overrides,
  };
}

const row = (page: Page, label: string) =>
  page.locator('.mnd-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');
const star = (page: Page) => page.getByRole('button', { name: `Star ${service}` });
const pageFits = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('.mnd-page')!;
    return root.scrollWidth <= root.clientWidth && document.documentElement.scrollWidth <= window.innerWidth;
  });

test('the masternode page shows the node and the PoSe history of this registration only @smoke', async ({ page }, testInfo) => {
  await stubApi(page, api());
  await page.goto(`/masternode/${proTx}`);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(service);
  await expect(row(page, 'Status')).toContainText('PoSe Penalty');
  await expect(row(page, 'proTxHash')).toContainText(proTx);
  await expect(row(page, 'proTxHash').getByRole('button', { name: 'Copy proTxHash' })).toBeVisible();
  await expect(row(page, 'Collateral').first()).toContainText(nodeId);
  await expect(row(page, 'Version')).toHaveText('23.0.0');
  await expect(row(page, 'Registered').getByRole('link')).toHaveAttribute('href', '/block/120000');
  await expect(row(page, 'PoSe penalty')).toHaveText('33');
  await expect(row(page, 'PoSe ban block')).toHaveText('Not banned');
  await expect(row(page, 'Last revived').getByRole('link')).toHaveAttribute('href', '/block/125000');
  await expect(row(page, 'Payout').getByRole('link')).toHaveAttribute('href', `/address/${detail.payoutAddress}`);
  await expect(row(page, 'Owner').getByRole('link')).toHaveAttribute('href', `/address/${detail.ownerAddress}`);
  await expect(row(page, 'Voting').getByRole('link')).toHaveAttribute('href', `/address/${detail.votingAddress}`);
  await expect(row(page, 'Operator key')).toContainText(detail.operatorPubkey);
  await expect(row(page, 'Country')).toContainText('Germany');
  await expect(row(page, 'Provider')).toContainText('Hetzner');
  await expect(row(page, 'Provider')).toContainText('Tagged');
  await expect(row(page, 'Network')).toContainText('AS24940');
  await expect(page.getByRole('link', { name: 'Open in PoSe Watch' })).toHaveAttribute('href', `/ban-detection?node=${proTx}`);
  // The payout estimate of the endpoint is a guess from registration order: not shown.
  await expect(page.locator('.mnd-page')).not.toContainText(/queue|next payout/i);

  const history = page.locator('.mnd-events tbody tr');
  await expect(history).toHaveCount(2);
  await expect(history.nth(0)).toContainText('Enabled → PoSe Penalty');
  await expect(history.nth(1)).toContainText('PoSe ban, later recovered');
  await expect(history.nth(1).getByRole('link', { name: '124,000' })).toHaveAttribute('href', '/block/124000');
  await expect(history.nth(1).getByRole('link', { name: '125,000' })).toHaveAttribute('href', '/block/125000');
  await expect(page.locator('.mnd-page')).not.toContainText('110,000');
  await expect(page.getByText('2 stored events of this collateral are not shown')).toBeVisible();
  expect(await pageFits(page)).toBe(true);
  if (testInfo.project.name.includes('mobile')) {
    // Touch targets of at least 40 px on a phone.
    const copy = await row(page, 'proTxHash').getByRole('button', { name: 'Copy proTxHash' }).boundingBox();
    const watch = await page.getByRole('link', { name: 'Open in PoSe Watch' }).boundingBox();
    expect(copy!.height).toBeGreaterThanOrEqual(40);
    expect(watch!.height).toBeGreaterThanOrEqual(40);
  }
});

test('without a registration time no plain status change is counted for this registration @smoke', async ({ page }) => {
  await stubApi(page, api({ [`/api/v1/masternodes/${proTx}`]: { success: true, data: { ...detail, registeredAt: null } } }));
  await page.goto(`/masternode/${proTx}`);
  const history = page.locator('.mnd-events tbody tr');
  await expect(history).toHaveCount(1);
  await expect(history.first()).toContainText('PoSe ban, later recovered');
  await expect(page.getByText('3 stored events of this collateral are not shown')).toBeVisible();
});

test('an unknown proTxHash shows "not found", an invalid one sends no request, upper case is redirected @smoke', async ({ page }) => {
  const unknown = '12'.repeat(32);
  const detailRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/api/v1/masternodes/')) detailRequests.push(request.url()); });
  await stubApi(page, api());
  await page.route(`**/api/v1/masternodes/${unknown}`, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Masternode not found' } }) }));

  await page.goto(`/masternode/${unknown}`);
  await expect(page.getByText('Masternode not found')).toBeVisible();
  await expect(page.getByText('The current masternode list has no registration with this proTxHash')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the Masternodes table' })).toHaveAttribute('href', '/masternodes');
  expect(detailRequests.filter((url) => url.includes('/events'))).toHaveLength(0);

  detailRequests.length = 0;
  await page.goto('/masternode/not-a-hash');
  await expect(page.getByText('"not-a-hash" is not a proTxHash')).toBeVisible();
  expect(detailRequests).toHaveLength(0);

  // A pasted collateral outpoint is long and unbroken: it wraps inside the panel.
  const outpoint = `${'9'.repeat(64)}-1`;
  await page.goto(`/masternode/${outpoint}`);
  await expect(page.getByText(`"${outpoint}" is not a proTxHash`)).toBeVisible();
  expect(await page.locator('.state-panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);

  await page.goto(`/masternode/${proTx.toUpperCase()}`);
  await expect(page).toHaveURL(new RegExp(`/masternode/${proTx}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(service);
});

test('a failed node request and a failed history request each say so; versions fall back to unavailable @smoke', async ({ page }) => {
  // Only the node itself answers: the history and the versions get the stub's 503.
  await stubApi(page, { [`/api/v1/masternodes/${proTx}`]: { success: true, data: detail } });
  await page.goto(`/masternode/${proTx}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(service);
  await expect(page.getByText('PoSe history could not be loaded')).toBeVisible();
  await expect(row(page, 'Version')).toHaveText('Unavailable right now');

  await stubApi(page, {});
  await page.goto(`/masternode/${'34'.repeat(32)}`);
  await expect(page.getByText('Masternode could not be loaded')).toBeVisible();
});

test('a node naming another registration, or an unreadable answer, is refused rather than shown @smoke', async ({ page }) => {
  await stubApi(page, api({ [`/api/v1/masternodes/${proTx}`]: { success: true, data: { ...detail, proTxHash: otherProTx } } }));
  await page.goto(`/masternode/${proTx}`);
  await expect(page.getByText('Masternode could not be loaded')).toBeVisible();
  await expect(page.getByText('Masternode identity mismatch')).toBeVisible();

  const { status: _status, ...withoutStatus } = detail;
  await stubApi(page, api({ [`/api/v1/masternodes/${proTx}`]: { success: true, data: withoutStatus } }));
  await page.goto(`/masternode/${proTx}`);
  await expect(page.getByText('The masternode answer could not be read')).toBeVisible();
});

test('a star keeps the node in My nodes after a reload @smoke', async ({ page }) => {
  await stubApi(page, api());
  await page.goto(`/masternode/${proTx}`);
  await expect(star(page)).toHaveAttribute('aria-pressed', 'false');
  await star(page).click();
  await expect(star(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate((key) => window.localStorage.getItem(key), FAVORITES_KEY)).toBe(JSON.stringify([proTx]));

  await page.reload();
  await expect(star(page)).toHaveAttribute('aria-pressed', 'true');
  await star(page).click();
  await expect(star(page)).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate((key) => window.localStorage.getItem(key), FAVORITES_KEY)).toBe('[]');
});

test('with storage blocked the page works and the star lasts until a reload @smoke', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });
  });
  await stubApi(page, api());
  await page.goto(`/masternode/${proTx}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(service);
  await star(page).click();
  await expect(star(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('This browser does not allow saving here, so your stars are kept only until the page is reloaded or closed.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('when saving is refused the star still works until a reload @smoke', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Reading works (nothing saved yet); every write is refused, as with a full or locked storage.
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('refused', 'QuotaExceededError'); };
  });
  await stubApi(page, api());
  await page.goto(`/masternode/${proTx}`);
  await star(page).click();
  await expect(star(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('This browser does not allow saving here, so your stars are kept only until the page is reloaded or closed.')).toBeVisible();
  await page.reload();
  await expect(star(page)).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('a star given in one tab shows in another tab of the same site @smoke', async ({ page }) => {
  await stubApi(page, api());
  const other = await page.context().newPage();
  await stubApi(other, api());
  await page.goto(`/masternode/${proTx}`);
  await other.goto(`/masternode/${proTx}`);
  await expect(star(other)).toHaveAttribute('aria-pressed', 'false');
  await star(page).click();
  await expect(star(other)).toHaveAttribute('aria-pressed', 'true');
});

test('history events of another node id are refused rather than shown @smoke', async ({ page }) => {
  await stubApi(page, api({ [`/api/v1/masternodes/${nodeId}/events`]: { success: true, data: [{ ...events[0], nodeId: 'another-node' }] } }));
  await page.goto(`/masternode/${proTx}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(service);
  await expect(page.getByText('PoSe history could not be loaded')).toBeVisible();
});

test('a damaged saved list counts as empty, and a full list refuses a new star @smoke', async ({ page }) => {
  await page.addInitScript((key) => window.localStorage.setItem(key, '{not json'), FAVORITES_KEY);
  await stubApi(page, api());
  await page.goto(`/masternode/${proTx}`);
  await expect(star(page)).toHaveAttribute('aria-pressed', 'false');

  const full = Array.from({ length: 50 }, (_, index) => index.toString(16).padStart(64, '0'));
  await page.evaluate(([key, list]) => window.localStorage.setItem(key as string, JSON.stringify(list)), [FAVORITES_KEY, full] as const);
  // The init script would put the damaged value back on reload; open a fresh page in the same context.
  const fresh = await page.context().newPage();
  await stubApi(fresh, api());
  await fresh.goto(`/masternode/${proTx}`);
  await star(fresh).click();
  await expect(star(fresh)).toHaveAttribute('aria-pressed', 'false');
  await expect(fresh.getByText('My nodes is full (50). Remove a star first.')).toBeVisible();
  expect(JSON.parse((await fresh.evaluate((key) => window.localStorage.getItem(key), FAVORITES_KEY))!)).toHaveLength(50);
});
