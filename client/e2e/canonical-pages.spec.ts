import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './apiStub';
import { openHeaderSearch } from './headerSearch';

// Every block, transaction and address has one address: /block/<height or hash>, /tx/<txid>,
// /address/<address>. /search resolves a query and moves on; old /searchv2 links lead there too.

const BLOCK_TIME = 1_788_609_600; // 2026-09-05 12:00:00 UTC
const HASH = 'a'.repeat(64);
const TXID = 'c'.repeat(64);
const SENDER = `D${'S'.repeat(33)}`;
const RECIPIENT = `D${'R'.repeat(33)}`;

function block(height: number) {
  return {
    hash: HASH, height, confirmations: 3, size: 538, version: 0x20000000, merkleroot: 'b'.repeat(64),
    time: BLOCK_TIME, mediantime: BLOCK_TIME, nonce: 0, bits: '190a969d', difficulty: 400_000_000, chainwork: '0', nTx: 0,
    rewardSat: 1_050_000_000_000, totalValueOutSat: 0, txids: [], reward: 10_500, totalValueOut: 0,
  };
}

// SENDER spends 15 DFCN: 10 to RECIPIENT, 4.9999 back to itself, 0.0001 fee.
function transaction() {
  const output = (n: number, value: number, address: string, type: string) => ({
    n, value, valueSat: String(Math.round(value * 1e8)), scriptPubKey: { asm: '', hex: '', type, addresses: [address] },
  });
  return {
    txid: TXID, blockhash: HASH, blockheight: 123_456, blocktime: BLOCK_TIME, version: 3, size: 225, locktime: 0,
    vin: [{ txid: 'd'.repeat(64), vout: 0, sequence: 0, address: SENDER, value: 15, valueSat: '1500000000' }],
    vout: [output(0, 10, RECIPIENT, 'pubkeyhash'), output(1, 4.9999, SENDER, 'pubkey')],
    totalValueIn: 15, totalValueOut: 14.9999, fee: 0.0001,
    totalValueInSat: '1500000000', totalValueOutSat: '1499990000', feeSat: '10000',
    isCoinbase: false, confirmations: 3,
  };
}

const searchFound = (data: Record<string, unknown>) => ({ success: true, data });
const txFound = { [`/api/tx/${TXID}`]: { success: true, data: transaction() } };

/** Counts the browser's requests to one API path, retries included. */
function countRequests(page: Page, pathname: string) {
  const seen = { count: 0 };
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === pathname) seen.count += 1;
  });
  return seen;
}

/** A response held back until the test opens it. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open: () => open(), opened };
}

/** Answers the given API paths with a 404 "not found", after (so ahead of) the generic stub. */
async function answerNotFound(page: Page, paths: string[]) {
  await page.route((url) => url.pathname.startsWith('/api/') && paths.includes(url.pathname), (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }),
  }));
}

test('the search page opens a matching block on its own page @smoke', async ({ page }) => {
  await stubApi(page, {
    '/api/search': searchFound({ type: 'block', matchedBy: 'height', result: { height: 123_456, hash: HASH } }),
    '/api/block/123456': { success: true, data: block(123_456) },
    '/api/block/123456/txs': { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } },
  });

  await page.goto('/search');
  await page.getByLabel('Search the chain').fill('123456');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  await expect(page).toHaveURL(/\/block\/123456$/);
  await expect(page.getByRole('heading', { name: 'Block #123,456' })).toBeVisible();
});

test('the header search opens the transaction page, its links are direct, and Back returns home @smoke', async ({ page }) => {
  await stubApi(page, {
    '/api/search': searchFound({ type: 'transaction', matchedBy: 'txid', result: { txid: TXID } }),
    ...txFound,
  });

  await page.goto('/');
  const search = await openHeaderSearch(page);
  await search.fill(TXID);
  await search.press('Enter');

  await expect(page).toHaveURL(new RegExp(`/tx/${TXID}$`));
  await expect(page.getByRole('heading', { name: 'Transaction', exact: true })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`/tx/${TXID}$`));

  // Every input and output, each linked to its own address page, and the block by height.
  await expect(page.locator(`.searchv2-flow-card a[href="/address/${SENDER}"]`)).toHaveCount(2);
  await expect(page.locator(`.searchv2-flow-card a[href="/address/${RECIPIENT}"]`)).toHaveCount(1);
  await expect(page.locator('a[href="/block/123456"]').first()).toBeVisible();
  await expect(page.locator('a[href*="searchv2"], a[href^="/search"]')).toHaveCount(0);
  // On a phone the long txid wraps inside the card instead of running off the screen.
  const headerFitsCard = await page.locator('.searchv2-flow-card').first().evaluate((card) => {
    const right = card.getBoundingClientRect().right;
    return [...card.querySelectorAll('.searchv2-flow-hashline a, .searchv2-flow-meta')]
      .every((element) => element.getBoundingClientRect().right <= right + 0.5);
  });
  expect(headerFitsCard).toBe(true);

  // Each output keeps its script type, as on the old transaction page.
  const outputs = page.locator('.searchv2-flow-card .searchv2-flow-column').nth(1);
  await expect(outputs.locator('.searchv2-flow-node-type')).toHaveText(['pubkeyhash', 'pubkey']);

  // What the flow view does not show stays in the details block.
  const details = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Details' }) });
  await expect(details.locator('.detail-row').filter({ hasText: 'Size' })).toContainText('225 B');
  await expect(details.locator('.detail-row').filter({ hasText: 'Confirmations' })).toContainText('3');
  await expect(details.locator('.detail-row').filter({ hasText: 'TX Hash' })).toContainText(TXID);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.dashboard-hero')).toBeVisible();
});

test('an old /searchv2 link lands on the transaction page without a step to go back through @smoke', async ({ page }) => {
  await stubApi(page, {
    '/api/search': searchFound({ type: 'transaction', matchedBy: 'txid', result: { txid: TXID } }),
    ...txFound,
  });

  await page.goto('/');
  await expect(page.locator('.dashboard-hero')).toBeVisible();
  // Follow an old link inside the app: /searchv2 → /search → /tx, each step replacing the last.
  await page.evaluate((txid) => {
    window.history.pushState({ usr: null, key: 'legacy', idx: 1 }, '', `/searchv2?q=${txid}`);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, TXID);

  await expect(page).toHaveURL(new RegExp(`/tx/${TXID}$`));
  await expect(page.getByRole('heading', { name: 'Transaction', exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test('an address search opens the address page with its flows @smoke', async ({ page }) => {
  await stubApi(page, {
    '/api/search': searchFound({ type: 'address', matchedBy: 'address', result: { address: SENDER } }),
    [`/api/address/${SENDER}`]: {
      success: true,
      data: { address: SENDER, balance: 4.9999, totalReceived: 19.9999, totalSent: 15, txCount: 1,
        balanceSat: '499990000', totalReceivedSat: '1999990000', totalSentSat: '1500000000' },
    },
    [`/api/address/${SENDER}/txs`]: { success: true, data: [transaction()], pagination: { page: 1, limit: 8, total: 1, pages: 1 } },
  });

  await page.goto(`/search?q=${SENDER}`);

  await expect(page).toHaveURL(new RegExp(`/address/${SENDER}$`));
  await expect(page.getByRole('heading', { name: 'Address', exact: true })).toBeVisible();
  await expect(page.locator('.stat-card').filter({ hasText: 'Transactions' })).toContainText('1');
  const flow = page.locator('.searchv2-flow-card');
  await expect(flow).toHaveCount(1);
  await expect(flow).toContainText('Self / Change Out');
  await expect(flow).toContainText('Net on this address: -10.0001 DFCN');
  // The address's own rows open the transaction; the other side opens its address.
  await expect(flow.locator(`a[href="/tx/${TXID}"]`).first()).toBeVisible();
  await expect(flow.locator(`a[href="/address/${RECIPIENT}"]`)).toHaveCount(1);
  await expect(flow.locator(`a[href="/address/${SENDER}"]`)).toHaveCount(0);
  await expect(flow.locator('.searchv2-flow-node-type')).toHaveCount(0);
});

test('a txid or address the index does not know ends on that page\'s "not found" state @smoke', async ({ page }) => {
  await stubApi(page, {
    [`/api/address/${RECIPIENT}/txs`]: { success: true, data: [], pagination: { page: 1, limit: 8, total: 0, pages: 0 } },
  });
  await answerNotFound(page, ['/api/search', `/api/tx/${TXID}`, `/api/address/${RECIPIENT}`]);
  const txRequests = countRequests(page, `/api/tx/${TXID}`);

  await page.goto(`/search?q=${TXID}`);
  await expect(page).toHaveURL(new RegExp(`/tx/${TXID}$`));
  await expect(page.getByText('Transaction not found')).toBeVisible();
  expect(txRequests.count).toBe(1); // a "not found" answer is not retried

  await page.goto(`/search?q=${RECIPIENT}`);
  await expect(page).toHaveURL(new RegExp(`/address/${RECIPIENT}$`));
  await expect(page.getByText('Address not found')).toBeVisible();
});

test('no match, an invalid query and a failing search each say what happened @smoke', async ({ page }) => {
  const tooLong = 'x'.repeat(129);
  await stubApi(page);
  // The server's answers: 404 when nothing matches, 400 for a query over 128 characters.
  await page.route((url) => url.pathname === '/api/search', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    const [status, code, message] = q === 'nothing-here'
      ? [404, 'NOT_FOUND', 'No results found']
      : q.length > 128 ? [400, 'BAD_REQUEST', 'Query too long'] : [503, 'UNAVAILABLE', 'Search backend error'];
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code, message } }) });
  });
  const searches = countRequests(page, '/api/search');

  await page.goto('/search?q=nothing-here');
  await expect(page.getByText('No results found')).toBeVisible();
  await expect(page).toHaveURL(/\/search\?q=nothing-here$/);
  expect(searches.count).toBe(1);

  await page.goto(`/search?q=${tooLong}`);
  await expect(page.getByText('That search is not valid')).toBeVisible();
  await expect(page.getByText('Query too long')).toBeVisible();
  expect(searches.count).toBe(2);

  // A failed request is tried once more before the page gives up.
  await page.goto('/search?q=still-nothing');
  await expect(page.getByText('Search is not available right now')).toBeVisible();
  await expect(page.getByText('No results found')).toHaveCount(0);
  expect(searches.count).toBe(4);
});

test('the address and transaction pages tell a missing summary and a failed request apart @smoke', async ({ page }) => {
  await stubApi(page, {
    [`/api/address/${SENDER}/txs`]: { success: true, data: [transaction()], pagination: { page: 1, limit: 8, total: 1, pages: 1 } },
    [`/api/address/${RECIPIENT}/txs`]: { success: true, data: [transaction()], pagination: { page: 1, limit: 8, total: 1, pages: 1 } },
  });
  // SENDER has transactions but no summary yet; RECIPIENT's summary and the transaction fail (503).
  await answerNotFound(page, [`/api/address/${SENDER}`]);
  const summaryRequests = countRequests(page, `/api/address/${RECIPIENT}`);
  const txRequests = countRequests(page, `/api/tx/${TXID}`);

  await page.goto(`/address/${SENDER}`);
  await expect(page.getByText('Address summary is not indexed yet')).toBeVisible();
  await expect(page.locator('.searchv2-flow-card')).toHaveCount(1);
  await expect(page.getByText('Address not found')).toHaveCount(0);

  await page.goto(`/address/${RECIPIENT}`);
  await expect(page.getByText('Address details could not be loaded')).toBeVisible();
  await expect(page.locator('.searchv2-flow-card')).toHaveCount(1);
  await expect(page.getByText('Address summary is not indexed yet')).toHaveCount(0);
  expect(summaryRequests.count).toBe(2); // a failed request is tried once more

  await page.goto(`/tx/${TXID}`);
  await expect(page.getByText('Transaction could not be loaded')).toBeVisible();
  await expect(page.getByText('Transaction not found')).toHaveCount(0);
  expect(txRequests.count).toBe(2);
});

test("moving to the next block never shows the previous block's data while the new one loads @smoke", async ({ page }) => {
  const oldTx = 'e'.repeat(64);
  const newTx = 'f'.repeat(64);
  const blockTxs = (txid: string) => ({
    success: true,
    data: [{ txid, totalValueOut: 1, fee: 0, size: 200, isDonation: false }],
    pagination: { page: 1, limit: 20, total: 1, pages: 1 },
  });
  await stubApi(page, {
    '/api/block/123456': { success: true, data: { ...block(123_456), nTx: 1, nextblockhash: 'b'.repeat(64) } },
    '/api/block/123456/txs': blockTxs(oldTx),
  });
  // The next block's details and its transaction list each wait until the test lets them through.
  const details = gate();
  const txs = gate();
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route((url) => url.pathname === '/api/block/123457', async (route) => {
    await details.opened;
    await route.fulfill(json({ success: true, data: { ...block(123_457), nTx: 1 } }));
  });
  await page.route((url) => url.pathname === '/api/block/123457/txs', async (route) => {
    await txs.opened;
    await route.fulfill(json(blockTxs(newTx)));
  });

  await page.goto('/block/123456');
  await expect(page.locator(`a[href="/tx/${oldTx}"]`)).toBeVisible();
  await page.getByRole('link', { name: 'Block #123,457' }).click();

  // Nothing has arrived yet: no trace of the previous block under the new address.
  await expect(page).toHaveURL(/\/block\/123457$/);
  await expect(page.getByText('Loading block...')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Block #123,456' })).toHaveCount(0);
  await expect(page.locator(`a[href="/tx/${oldTx}"]`)).toHaveCount(0);

  // The details arrive first: the new block, and still none of the previous block's transactions.
  details.open();
  await expect(page.getByRole('heading', { name: 'Block #123,457' })).toBeVisible();
  await expect(page.getByText('Loading transactions...')).toBeVisible();
  await expect(page.locator(`a[href="/tx/${oldTx}"]`)).toHaveCount(0);

  txs.open();
  await expect(page.locator(`a[href="/tx/${newTx}"]`)).toBeVisible();
  await expect(page.locator(`a[href="/tx/${oldTx}"]`)).toHaveCount(0);
});
