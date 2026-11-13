import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubApi } from './apiStub';

// The address, the transaction ID and the block hash each have a copy button that copies the
// whole value and says whether it worked. The address page is titled by the address itself.

const BLOCK_TIME = 1_788_609_600; // 2026-09-05 12:00:00 UTC
const HASH = `00000a${'b'.repeat(52)}c0ffee`;
const TXID = `d${'e'.repeat(62)}f`;
const OTHER_TXID = `9${'8'.repeat(62)}7`;
const ADDRESS = 'DGK3yNxxedc2pvaPPwTbVBey2NmFC8FUGZ';
const OTHER = `D${'R'.repeat(33)}`;

function block() {
  return {
    hash: HASH, height: 123_456, confirmations: 3, size: 538, version: 0x20000000, merkleroot: 'b'.repeat(64),
    time: BLOCK_TIME, mediantime: BLOCK_TIME, nonce: 0, bits: '190a969d', difficulty: 400_000_000, chainwork: '0', nTx: 0,
    rewardSat: 1_050_000_000_000, totalValueOutSat: 0, txids: [], reward: 10_500, totalValueOut: 0,
    previousblockhash: 'a'.repeat(64), nextblockhash: 'c'.repeat(64),
  };
}

// ADDRESS pays 10 DFCN to OTHER and keeps 4.9999; 0.0001 fee.
function transaction() {
  const output = (n: number, value: number, address: string) => ({
    n, value, valueSat: String(Math.round(value * 1e8)), scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash', addresses: [address] },
  });
  return {
    txid: TXID, blockhash: HASH, blockheight: 123_456, blocktime: BLOCK_TIME, version: 3, size: 225, locktime: 0,
    vin: [{ txid: 'f'.repeat(64), vout: 0, sequence: 0, address: ADDRESS, value: 15, valueSat: '1500000000' }],
    vout: [output(0, 10, OTHER), output(1, 4.9999, ADDRESS)],
    totalValueIn: 15, totalValueOut: 14.9999, fee: 0.0001,
    totalValueInSat: '1500000000', totalValueOutSat: '1499990000', feeSat: '10000',
    isCoinbase: false, confirmations: 3,
  };
}

const API = {
  [`/api/address/${ADDRESS}`]: {
    success: true,
    data: { address: ADDRESS, balance: 4.9999, totalReceived: 19.9999, totalSent: 15, txCount: 1,
      balanceSat: '499990000', totalReceivedSat: '1999990000', totalSentSat: '1500000000' },
  },
  [`/api/address/${ADDRESS}/txs`]: { success: true, data: [transaction()], pagination: { page: 1, limit: 20, total: 1, pages: 1 } },
  [`/api/tx/${TXID}`]: { success: true, data: transaction() },
  '/api/block/123456': { success: true, data: block() },
  '/api/block/123456/txs': { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } },
};

/**
 * Replaces the browser clipboard with a recorder, so each test reads exactly what was copied
 * without sharing the system clipboard with tests running in parallel. `refuse` makes every
 * write fail, as a browser does when clipboard access is denied; `missing` removes the
 * clipboard API altogether, as on a page served without HTTPS.
 */
async function recordClipboard(page: Page, { refuse = false, missing = false } = {}) {
  await page.addInitScript(({ refuseWrites, noApi }) => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: noApi ? undefined : {
        writeText: (text: string) => {
          if (refuseWrites) return Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
  }, { refuseWrites: refuse, noApi: missing });
}

/** Moves to another page inside the app, without a reload, as a link or the header search does. */
async function navigateInApp(page: Page, path: string) {
  await page.evaluate((target) => {
    window.history.pushState({ usr: null, key: 'next', idx: 1 }, '', target);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, path);
}

const copiedValues = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

/** The status next to a copy button, found from the button itself. */
const statusOf = (button: Locator) => button.locator('xpath=..').getByRole('status');

/** Waits until the web fonts have loaded, so a late font swap cannot move what a test measures. */
const fontsReady = (page: Page) => page.evaluate(async () => { await document.fonts.ready; });

/** True when nothing on the page is wider than the window (no sideways scrolling). */
const fitsWindow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** True when the element shows all of its text: nothing is cut off or hidden by overflow. */
const showsAllText = (locator: Locator) =>
  locator.evaluate((element) => element.scrollWidth <= element.clientWidth + 0.5);

test('the address page is titled by the full address, and its copy button copies all of it @smoke', async ({ page }) => {
  await recordClipboard(page);
  await stubApi(page, API);
  await page.goto(`/address/${ADDRESS}`);

  const title = page.getByRole('heading', { level: 1 });
  await expect(title).toHaveText(ADDRESS);
  await expect(page.locator('.page-kicker')).toHaveText('Address');
  expect(await showsAllText(title)).toBe(true);
  await expect(page.locator('.stat-card').filter({ hasText: 'Balance' })).toBeVisible();

  const copy = page.getByRole('button', { name: 'Copy address' });
  await expect(statusOf(copy)).toHaveText('');
  await fontsReady(page);
  const titleBefore = await title.boundingBox();
  await copy.click();
  await expect(statusOf(copy)).toHaveText('Copied');
  expect(await copiedValues(page)).toEqual([ADDRESS]);
  // The confirmation does not push the address around, and stays inside the window.
  expect(await title.boundingBox()).toEqual(titleBefore);
  expect(await fitsWindow(page)).toBe(true);
  // It goes away again, ready for the next copy.
  await expect(statusOf(copy)).toHaveText('', { timeout: 5_000 });

  // On a phone the address wraps beside its button instead of pushing the page sideways.
  const button = await copy.boundingBox();
  expect(button).not.toBeNull();
  expect(button!.x + button!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await fitsWindow(page)).toBe(true);
});

test('the transaction page copies the full transaction ID @smoke', async ({ page }) => {
  await recordClipboard(page);
  await stubApi(page, API);
  await page.goto(`/tx/${TXID}`);

  await expect(page.getByRole('heading', { name: 'Transaction', exact: true, level: 1 })).toBeVisible();
  // From the keyboard: the button takes focus and Enter copies.
  const copy = page.getByRole('button', { name: 'Copy transaction ID' });
  await copy.focus();
  await page.keyboard.press('Enter');
  await expect(statusOf(copy)).toHaveText('Copied');
  expect(await copiedValues(page)).toEqual([TXID]);
  expect(await fitsWindow(page)).toBe(true);
});

test('the block page shows and copies the full hash, with its title at the left edge @smoke', async ({ page }) => {
  await recordClipboard(page);
  await stubApi(page, API);
  await page.goto('/block/123456');

  const title = page.getByRole('heading', { name: 'Block #123,456', level: 1 });
  await expect(title).toBeVisible();
  const neighbours = page.getByRole('navigation', { name: 'Neighbouring blocks' });
  await expect(neighbours.getByRole('link')).toHaveText(['Block #123,455', 'Block #123,457']);

  // The title starts where the details card starts, as on the other pages.
  await fontsReady(page);
  const details = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Block Details' }) });
  const [titleBox, cardBox] = await Promise.all([title.boundingBox(), details.boundingBox()]);
  expect(Math.abs(titleBox!.x - cardBox!.x)).toBeLessThanOrEqual(1);

  // The whole hash is on screen, not cut off with an ellipsis, and the button copies all of it.
  const hashRow = details.locator('.detail-row').filter({ hasText: 'Hash' });
  const hash = hashRow.locator('.detail-value-id');
  await expect(hash).toHaveText(HASH);
  expect(await showsAllText(hash)).toBe(true);
  const copy = hashRow.getByRole('button', { name: 'Copy block hash' });
  const hashBefore = await hash.boundingBox();
  await copy.click();
  await expect(statusOf(copy)).toHaveText('Copied');
  await expect(statusOf(copy)).toBeVisible();
  expect(await copiedValues(page)).toEqual([HASH]);
  expect(await hash.boundingBox()).toEqual(hashBefore);
  expect(await fitsWindow(page)).toBe(true);
});

test('opening another address does not carry the previous "Copied" note over to it @smoke', async ({ page }) => {
  await recordClipboard(page);
  await stubApi(page, {
    ...API,
    [`/api/address/${OTHER}`]: {
      success: true,
      data: { address: OTHER, balance: 10, totalReceived: 10, totalSent: 0, txCount: 1,
        balanceSat: '1000000000', totalReceivedSat: '1000000000', totalSentSat: '0' },
    },
    [`/api/address/${OTHER}/txs`]: { success: true, data: [transaction()], pagination: { page: 1, limit: 20, total: 1, pages: 1 } },
  });
  await page.goto(`/address/${ADDRESS}`);
  await page.getByRole('button', { name: 'Copy address' }).click();
  await expect(statusOf(page.getByRole('button', { name: 'Copy address' }))).toHaveText('Copied');

  // Well inside the note's two seconds, the next address shows with no note beside it.
  await navigateInApp(page, `/address/${OTHER}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(OTHER);
  expect(await statusOf(page.getByRole('button', { name: 'Copy address' })).textContent()).toBe('');
  expect(await copiedValues(page)).toEqual([ADDRESS]);
});

test('opening another transaction does not carry the previous "Copied" note over to it @smoke', async ({ page }) => {
  await recordClipboard(page);
  await stubApi(page, { ...API, [`/api/tx/${OTHER_TXID}`]: { success: true, data: { ...transaction(), txid: OTHER_TXID } } });
  await page.goto(`/tx/${TXID}`);
  await page.getByRole('button', { name: 'Copy transaction ID' }).click();
  await expect(statusOf(page.getByRole('button', { name: 'Copy transaction ID' }))).toHaveText('Copied');

  await navigateInApp(page, `/tx/${OTHER_TXID}`);
  await expect(page.locator('.page-subtitle')).toHaveText(OTHER_TXID);
  expect(await statusOf(page.getByRole('button', { name: 'Copy transaction ID' })).textContent()).toBe('');
  expect(await copiedValues(page)).toEqual([TXID]);
});

test('without a clipboard API the button says the copy failed @smoke', async ({ page }) => {
  await recordClipboard(page, { missing: true });
  await stubApi(page, API);
  await page.goto('/block/123456');

  const copy = page.getByRole('button', { name: 'Copy block hash' });
  await copy.click();
  await expect(statusOf(copy)).toHaveText('Copy failed');
});

test('a refused clipboard says the copy failed instead of claiming success @smoke', async ({ page }) => {
  await recordClipboard(page, { refuse: true });
  await stubApi(page, API);
  await page.goto(`/address/${ADDRESS}`);

  const copy = page.getByRole('button', { name: 'Copy address' });
  await copy.click();
  await expect(statusOf(copy)).toHaveText('Copy failed');
  expect(await copiedValues(page)).toEqual([]);
});
