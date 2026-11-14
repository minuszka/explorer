import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './apiStub';

// The home page lists: each block names the address that made it (not the masternode it paid),
// each transaction carries the label the transaction page uses, rewards can be hidden, and the two
// lists show the same number of rows.

const NOW = 1_788_609_600; // 2026-09-05 12:00:00 UTC
const STAKER = 'DKgo69ycaxuut3QxaTSfyqbkFvyRvvq8Hf';
const PAYEE = 'DGK3yNxxedc2pvaPPwTbVBey2NmFC8FUGZ';
const MINER = 'D9NofFTND226dT475V33QaHU9LKHK7UwVe';
const SENDER = 'D8e1nUDayNHvXSYZPv1QECNcSgCxgsXw9d';
const TIP = 170_000;

const block = (n: number, producer: unknown) => ({
  hash: `${n}`.padStart(64, 'b'), height: TIP - n, time: NOW - n * 150, nTx: 3, confirmations: n + 1,
  reward: 10_500, minedBy: PAYEE, producer, size: 900,
});
const BLOCKS = Array.from({ length: 10 }, (_, n) =>
  block(n, n === 8 ? null : n === 9 ? { address: MINER, kind: 'miner' } : { address: STAKER, kind: 'staker' }));

const marker = { value: 0, scriptPubKey: { type: 'nonstandard', addresses: [] } };
const pay = (value: number, address: string) => ({ value, scriptPubKey: { type: 'pubkeyhash', addresses: [address] } });
const txid = (label: string, n: number) => `${label}${n}`.padStart(64, '0');
const reward = (n: number) => ({
  txid: txid('cb', n), blockheight: TIP - n, blocktime: NOW - n * 150, confirmations: n + 1, totalValueOut: 10_000,
  isCoinbase: true, vin: [], vout: [marker, pay(10_000, PAYEE)],
});
const stake = (n: number) => ({
  txid: txid('cs', n), blockheight: TIP - n, blocktime: NOW - n * 150, confirmations: n + 1, totalValueOut: 25_500,
  isCoinbase: false, vin: [{ address: STAKER }], vout: [marker, pay(25_500, STAKER)],
});
const transfer = (n: number) => ({
  txid: txid('tr', n), blockheight: TIP - n, blocktime: NOW - n * 150, confirmations: n + 1, totalValueOut: 99.9,
  isCoinbase: false, vin: [{ address: SENDER }], vout: [pay(40, MINER), pay(59.9, SENDER)],
});
// Fourteen latest transactions, as an older server sent them: more rows than blocks.
const TXS = [reward(0), stake(0), transfer(0), reward(1), stake(1), reward(2), stake(2), transfer(2), reward(3), stake(3), reward(4), stake(4), reward(5), stake(5)];
const TRANSFERS = [transfer(0), transfer(2), transfer(6)];

async function openHome(page: Page, overview: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(new Date(NOW * 1000));
  await stubApi(page, {
    '/api/dashboard/overview': { success: true, data: { stats: {}, blocks: BLOCKS, txs: TXS, transfers: TRANSFERS, ...overview } },
  });
  await page.goto('/');
  await expect(page.locator('.latest-card').first().locator('.latest-item-shell')).toHaveCount(10);
}

const blockList = (page: Page) => page.locator('.latest-card').filter({ has: page.getByRole('heading', { name: 'Latest Blocks' }) });
const txList = (page: Page) => page.locator('.latest-card').filter({ has: page.getByRole('heading', { name: 'Latest Transactions' }) });

test('each latest block names the address that staked or mined it, never the masternode it paid @smoke', async ({ page }) => {
  await openHome(page);
  const rows = blockList(page).locator('.latest-item-shell');

  await expect(rows.nth(0).locator('.latest-producer')).toHaveText(/^Staked by DKgo69/);
  await expect(rows.nth(0).locator('.latest-producer')).toHaveAttribute('title', STAKER);
  await expect(rows.nth(8).locator('.latest-producer')).toHaveText('Producer unknown');
  await expect(rows.nth(9).locator('.latest-producer')).toHaveText(/^Mined by D9NofF/);
  await expect(blockList(page)).not.toContainText('DGK3yN');
});

test('a latest block row shows height, transactions, age and producer; its reward waits in the opened details @smoke', async ({ page }) => {
  await openHome(page);
  const first = blockList(page).locator('.latest-item-shell').first();

  await expect(first.locator('.latest-item-trigger')).not.toContainText('bbbbbb');
  await expect(first.locator('.latest-item-trigger .reward-chip')).toHaveCount(0);
  await expect(first.locator('.latest-item-trigger')).not.toContainText('DFCN');

  await first.locator('.latest-item-trigger').click();
  await expect(first.locator('.latest-block-reward')).toContainText('Block reward 10,500');
});

test('each latest transaction carries the same label as the transaction page @smoke', async ({ page }) => {
  await openHome(page);
  const rows = txList(page).locator('.latest-item');

  await expect(rows.nth(0).locator('.latest-kind')).toHaveText('Reward');
  await expect(rows.nth(1).locator('.latest-kind')).toHaveText('Stake');
  await expect(rows.nth(2).locator('.latest-kind')).toHaveText('Transfer');
  await expect(txList(page)).not.toContainText('Block Reward');
});

test('the two lists show the same number of rows @smoke', async ({ page }) => {
  await openHome(page);

  await expect(txList(page).locator('.latest-item')).toHaveCount(10);
});

test('"Hide rewards" lists only other transactions and is remembered after a reload @smoke', async ({ page }) => {
  await openHome(page);
  const toggle = txList(page).getByRole('checkbox', { name: 'Hide rewards' });
  await expect(toggle).not.toBeChecked();

  await toggle.check();
  const rows = txList(page).locator('.latest-item');
  await expect(rows).toHaveCount(3);
  await expect(rows.locator('.latest-kind')).toHaveText(['Transfer', 'Transfer', 'Transfer']);

  await page.reload();
  await expect(txList(page).getByRole('checkbox', { name: 'Hide rewards' })).toBeChecked();
  await expect(txList(page).locator('.latest-item')).toHaveCount(3);
});

test('without a transfers list from the server, "Hide rewards" filters the latest transactions @smoke', async ({ page }) => {
  await openHome(page, { transfers: undefined });

  await txList(page).getByRole('checkbox', { name: 'Hide rewards' }).check();

  await expect(txList(page).locator('.latest-item .latest-kind')).toHaveText(['Transfer', 'Transfer']);
});

test('on a phone the amount of each latest transaction stays visible, and both cards fit the screen @smoke', async ({ page }) => {
  const width = 390;
  await page.setViewportSize({ width, height: 844 });
  await openHome(page);
  await blockList(page).locator('.latest-item-trigger').first().click();
  const amount = txList(page).locator('.latest-item').first().locator('.latest-amount');
  await expect(amount).toBeVisible();
  await expect(amount).toHaveText('10,000 DFCN');

  // Element geometry, not page scroll width: the list section clips what overflows it.
  const right = async (locator: ReturnType<Page['locator']>) => {
    const box = await locator.boundingBox();
    return box ? box.x + box.width : Number.POSITIVE_INFINITY;
  };
  for (const card of [blockList(page), txList(page)]) {
    expect(await right(card)).toBeLessThanOrEqual(width);
  }
  const txCardRight = await right(txList(page));
  for (const element of [
    amount,
    txList(page).getByRole('link', { name: 'View all' }),
    txList(page).getByRole('checkbox', { name: 'Hide rewards' }),
  ]) {
    expect(await right(element)).toBeLessThanOrEqual(txCardRight);
  }
  expect(await right(blockList(page).getByRole('link', { name: 'Open block' }))).toBeLessThanOrEqual(await right(blockList(page)));
});

test('the blocks page names each block\'s producer, not the masternode it paid @smoke', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW * 1000));
  await stubApi(page, {
    '/api/blocks': { success: true, data: BLOCKS.map((row) => ({ ...row, difficulty: 1, totalValueOut: 0 })), cursor: { mode: 'cursor', hasMore: false, next: null } },
  });
  await page.goto('/blocks');

  const table = page.locator('table');
  await expect(table.getByRole('columnheader', { name: 'Producer' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Extracted by' })).toHaveCount(0);
  const firstRow = table.locator('tbody tr').first();
  await expect(firstRow.getByRole('link', { name: /DKgo69/ })).toHaveAttribute('href', `/address/${STAKER}`);
  await expect(table.locator('tbody tr').nth(8)).toContainText('Unknown');
  await expect(table).not.toContainText('DGK3yN');
});
