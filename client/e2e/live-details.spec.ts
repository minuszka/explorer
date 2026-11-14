import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { stubApi } from './apiStub';

// An open transaction, block or address page follows the chain: when the realtime connection
// announces a new block, the page asks again and shows the new state without a reload.

const BLOCK_TIME = 1_788_609_600; // 2026-09-05 12:00:00 UTC
const TIP = 123_456;
const HASH = 'a'.repeat(64);
const NEXT_HASH = 'c'.repeat(64);
const TXID = `d${'e'.repeat(62)}f`;
const NEW_TXID = `7${'6'.repeat(62)}5`;
const ADDRESS = 'DGK3yNxxedc2pvaPPwTbVBey2NmFC8FUGZ';
const OTHER = `D${'R'.repeat(33)}`;

/**
 * A realtime connection that stays open and the chain tip it reports. `newBlock()` moves the tip
 * one block on and announces it the way the server does, with the next sequence number.
 */
async function followChain(page: Page) {
  let socket: WebSocketRoute | null = null;
  let seq = 1;
  const chain = {
    tip: TIP,
    async newBlock() {
      await expect.poll(() => socket !== null).toBe(true);
      chain.tip += 1;
      seq += 1;
      socket!.send(JSON.stringify({
        type: 'block:new', ts: new Date().toISOString(), seq,
        data: { hash: chain.tip === TIP + 1 ? NEXT_HASH : 'f'.repeat(64), height: chain.tip, time: BLOCK_TIME + 150, txCount: 2 },
      }));
    },
  };
  await page.routeWebSocket('**/ws', (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: 'hello', ts: new Date().toISOString(), seq: 1, data: {} }));
  });
  return chain;
}

function transaction(txid: string, height: number, tip: number) {
  const output = (n: number, value: number, address: string) => ({
    n, value, valueSat: String(Math.round(value * 1e8)), scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash', addresses: [address] },
  });
  return {
    txid, blockhash: HASH, blockheight: height, blocktime: BLOCK_TIME, version: 3, size: 225, locktime: 0,
    vin: [{ txid: 'f'.repeat(64), vout: 0, sequence: 0, address: ADDRESS, value: 15, valueSat: '1500000000' }],
    vout: [output(0, 10, OTHER), output(1, 4.9999, ADDRESS)],
    totalValueIn: 15, totalValueOut: 14.9999, fee: 0.0001,
    totalValueInSat: '1500000000', totalValueOutSat: '1499990000', feeSat: '10000',
    isCoinbase: false, confirmations: tip - height + 1,
  };
}

test('an open transaction page shows the new confirmation count after a block @smoke', async ({ page }) => {
  await stubApi(page);
  const chain = await followChain(page);
  await page.route(`**/api/tx/${TXID}`, (route) =>
    route.fulfill({ json: { success: true, data: transaction(TXID, TIP - 2, chain.tip) } }));

  await page.goto(`/tx/${TXID}`);
  const confirmations = page.locator('.detail-row')
    .filter({ has: page.locator('.detail-label', { hasText: /^Confirmations$/ }) })
    .locator('.detail-value');
  await expect(confirmations).toHaveText('3');

  await chain.newBlock();
  await expect(confirmations).toHaveText('4');
});

test('an open block page at the chain tip gains its link to the next block @smoke', async ({ page }) => {
  await stubApi(page, {
    [`/api/block/${TIP}/txs`]: { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } },
  });
  const chain = await followChain(page);
  await page.route(`**/api/block/${TIP}`, (route) => route.fulfill({ json: { success: true, data: {
    hash: HASH, height: TIP, confirmations: chain.tip - TIP + 1, size: 538, version: 0x20000000, merkleroot: 'b'.repeat(64),
    time: BLOCK_TIME, mediantime: BLOCK_TIME, nonce: 0, bits: '190a969d', difficulty: 400_000_000, chainwork: '0', nTx: 0,
    rewardSat: 1_050_000_000_000, totalValueOutSat: 0, txids: [], reward: 10_500, totalValueOut: 0,
    previousblockhash: 'e'.repeat(64), ...(chain.tip > TIP ? { nextblockhash: NEXT_HASH } : {}),
  } } }));

  await page.goto(`/block/${TIP}`);
  const nav = page.getByRole('navigation', { name: 'Neighbouring blocks' });
  await expect(page.getByText('1 Confirmations')).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Block #123,455' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Block #123,457' })).toHaveCount(0);

  await chain.newBlock();
  await expect(nav.getByRole('link', { name: 'Block #123,457' })).toHaveAttribute('href', `/block/${TIP + 1}`);
  await expect(page.getByText('2 Confirmations')).toBeVisible();
});

/**
 * An address page whose answers follow the chain tip. `options.fail` makes every answer after the
 * new block a server error; otherwise the list answer after the new block waits until `release()`.
 */
async function openAddress(page: Page, chain: Awaited<ReturnType<typeof followChain>>, options: { fail?: boolean } = {}) {
  await stubApi(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const seen = { summaryAfterBlock: 0, listAfterBlock: 0 };
  const txs = () => chain.tip > TIP
    ? [transaction(NEW_TXID, chain.tip, chain.tip), transaction(TXID, TIP - 2, chain.tip)]
    : [transaction(TXID, TIP - 2, chain.tip)];
  const failure = { status: 500, json: { success: false, error: { code: 'INTERNAL', message: 'Failed to fetch address' } } };
  await page.route(`**/api/address/${ADDRESS}`, (route) => {
    if (chain.tip > TIP) seen.summaryAfterBlock += 1;
    if (chain.tip > TIP && options.fail) return route.fulfill(failure);
    return route.fulfill({ json: { success: true, data: {
      address: ADDRESS, balance: 4.9999, totalReceived: 19.9999, totalSent: 15, txCount: txs().length,
      balanceSat: '499990000', totalReceivedSat: '1999990000', totalSentSat: '1500000000',
    } } });
  });
  await page.route(`**/api/address/${ADDRESS}/txs?*`, async (route) => {
    if (chain.tip > TIP) {
      seen.listAfterBlock += 1;
      if (options.fail) return route.fulfill(failure);
      await held;
    }
    return route.fulfill({ json: {
      success: true, data: txs(), pagination: { page: 1, limit: 20, total: txs().length, pages: 1 },
    } });
  });

  await page.goto(`/address/${ADDRESS}`);
  await expect(page.locator('.searchv2-address-total')).toHaveText('1 total transaction');
  await expect(page.locator(`a[href="/tx/${TXID}"]`).first()).toBeVisible();
  await expect(page.locator(`a[href="/tx/${NEW_TXID}"]`)).toHaveCount(0);
  return { seen, release: () => release() };
}

test('an open address page lists a transaction from the new block @smoke', async ({ page }) => {
  const chain = await followChain(page);
  const address = await openAddress(page, chain);

  await chain.newBlock();
  // While the new list is on its way, the current one stays on screen instead of a loading line.
  await expect.poll(() => address.seen.listAfterBlock).toBeGreaterThan(0);
  await expect(page.locator(`a[href="/tx/${TXID}"]`).first()).toBeVisible();
  await expect(page.getByText('Loading transactions for this address...')).toHaveCount(0);

  address.release();
  await expect(page.locator(`a[href="/tx/${NEW_TXID}"]`).first()).toBeVisible();
  await expect(page.locator('.searchv2-address-total')).toHaveText('2 total transactions');
});

// A refresh after a new block that fails keeps what the page already shows; the next block or
// poll tries again. Each page retries a failed request once, so two failed answers mean it gave up.

test('an open transaction page keeps the transaction when the refresh after a block fails @smoke', async ({ page }) => {
  await stubApi(page);
  const chain = await followChain(page);
  let afterBlock = 0;
  await page.route(`**/api/tx/${TXID}`, (route) => {
    if (chain.tip === TIP) return route.fulfill({ json: { success: true, data: transaction(TXID, TIP - 2, chain.tip) } });
    afterBlock += 1;
    return route.fulfill({ status: 500, json: { success: false, error: { code: 'INTERNAL', message: 'Failed to fetch transaction' } } });
  });

  await page.goto(`/tx/${TXID}`);
  const confirmations = page.locator('.detail-row')
    .filter({ has: page.locator('.detail-label', { hasText: /^Confirmations$/ }) })
    .locator('.detail-value');
  await expect(confirmations).toHaveText('3');

  await chain.newBlock();
  await expect.poll(() => afterBlock, { timeout: 10_000 }).toBe(2);
  await page.waitForTimeout(300);
  await expect(confirmations).toHaveText('3');
  await expect(page.getByText('Transaction could not be loaded')).toHaveCount(0);
});

test('an open block page keeps the block when the refresh after a block fails @smoke', async ({ page }) => {
  await stubApi(page, {
    [`/api/block/${TIP}/txs`]: { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } },
  });
  const chain = await followChain(page);
  let afterBlock = 0;
  await page.route(`**/api/block/${TIP}`, (route) => {
    if (chain.tip > TIP) {
      afterBlock += 1;
      return route.fulfill({ status: 500, json: { success: false, error: { code: 'INTERNAL', message: 'Failed to fetch block' } } });
    }
    return route.fulfill({ json: { success: true, data: {
      hash: HASH, height: TIP, confirmations: 1, size: 538, version: 0x20000000, merkleroot: 'b'.repeat(64),
      time: BLOCK_TIME, mediantime: BLOCK_TIME, nonce: 0, bits: '190a969d', difficulty: 400_000_000, chainwork: '0', nTx: 0,
      rewardSat: 1_050_000_000_000, totalValueOutSat: 0, txids: [], reward: 10_500, totalValueOut: 0,
      previousblockhash: 'e'.repeat(64),
    } } });
  });

  await page.goto(`/block/${TIP}`);
  await expect(page.getByText('1 Confirmations')).toBeVisible();

  await chain.newBlock();
  await expect.poll(() => afterBlock, { timeout: 10_000 }).toBe(2);
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: 'Block #123,456' })).toBeVisible();
  await expect(page.getByText('1 Confirmations')).toBeVisible();
  await expect(page.getByText('Block could not be loaded')).toHaveCount(0);
});

test('an open address page keeps its summary and list when the refresh after a block fails @smoke', async ({ page }) => {
  const chain = await followChain(page);
  const address = await openAddress(page, chain, { fail: true });

  await chain.newBlock();
  // Both the summary and the list are retried once.
  await expect.poll(() => address.seen.summaryAfterBlock, { timeout: 10_000 }).toBe(2);
  await expect.poll(() => address.seen.listAfterBlock, { timeout: 10_000 }).toBe(2);
  await page.waitForTimeout(300);
  await expect(page.locator(`a[href="/tx/${TXID}"]`).first()).toBeVisible();
  await expect(page.locator('.searchv2-address-total')).toHaveText('1 total transaction');
  await expect(page.getByText('Address details could not be loaded')).toHaveCount(0);
  await expect(page.getByText('Failed to fetch address')).toHaveCount(0);
});
