import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './apiStub';

// The block page names who made the block: the staker of a proof-of-stake block (read from its
// coinstake) or the miner of a premine block, and for a proof-of-stake block the masternode its
// reward paid. What the server could not read from the chain shows as "Unknown".

const BLOCK_TIME = 1_788_609_600; // 2026-09-05 12:00:00 UTC
const STAKER = 'DKgo69ycaxuut3QxaTSfyqbkFvyRvvq8Hf';
const PAYEE = 'DGK3yNxxedc2pvaPPwTbVBey2NmFC8FUGZ';
const MINER = `Z${'H'.repeat(33)}`;

function block(extra: Record<string, unknown>) {
  return {
    hash: 'a'.repeat(64), height: 123_456, confirmations: 3, size: 538, version: 0x20000000, merkleroot: 'b'.repeat(64),
    time: BLOCK_TIME, mediantime: BLOCK_TIME, nonce: 0, bits: '190a969d', difficulty: 400_000_000, chainwork: '0', nTx: 2,
    rewardSat: 1_050_000_000_000, totalValueOutSat: 0, txids: [], reward: 10_500, totalValueOut: 0,
    minedBy: PAYEE, ...extra,
  };
}

async function openBlock(page: Page, extra: Record<string, unknown>) {
  await stubApi(page, {
    '/api/block/123456': { success: true, data: block(extra) },
    '/api/block/123456/txs': { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } },
  });
  await page.goto('/block/123456');
  await expect(page.getByRole('heading', { name: 'Block #123,456' })).toBeVisible();
  return page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Block Details' }) });
}

const row = (details: ReturnType<Page['locator']>, label: string) =>
  details.locator('.detail-row').filter({ has: details.page().locator('.detail-label', { hasText: new RegExp(`^${label}$`) }) });

test('a proof-of-stake block names its staker and the masternode it paid @smoke', async ({ page }) => {
  const details = await openBlock(page, { producer: { address: STAKER, kind: 'staker' }, masternodePayee: PAYEE });

  await expect(row(details, 'Staked by').getByRole('link', { name: STAKER })).toHaveAttribute('href', `/address/${STAKER}`);
  await expect(row(details, 'Masternode payee').getByRole('link', { name: PAYEE })).toHaveAttribute('href', `/address/${PAYEE}`);
  // The coinbase payee is never presented as the block's producer.
  await expect(row(details, 'Producer')).toHaveCount(0);
  await expect(row(details, 'Mined by')).toHaveCount(0);
});

test('a premine block names its miner and has no masternode row @smoke', async ({ page }) => {
  const details = await openBlock(page, { producer: { address: MINER, kind: 'miner' }, masternodePayee: null, minedBy: MINER });

  await expect(row(details, 'Mined by').getByRole('link', { name: MINER })).toHaveAttribute('href', `/address/${MINER}`);
  await expect(row(details, 'Masternode payee')).toHaveCount(0);
  await expect(row(details, 'Staked by')).toHaveCount(0);
});

test('an unknown producer or payee shows as Unknown, never as the coinbase payee @smoke', async ({ page }) => {
  // An older server sends neither field; minedBy (the masternode) must not stand in for the producer.
  const unknown = await openBlock(page, {});
  await expect(row(unknown, 'Producer')).toContainText('Unknown');
  await expect(row(unknown, 'Producer').getByRole('link')).toHaveCount(0);
  await expect(unknown.getByRole('link', { name: PAYEE })).toHaveCount(0);
  await expect(row(unknown, 'Masternode payee')).toHaveCount(0);
});

test('a staker with an unreadable masternode payee shows the payee as Unknown @smoke', async ({ page }) => {
  const details = await openBlock(page, { producer: { address: STAKER, kind: 'staker' }, masternodePayee: null });

  await expect(row(details, 'Staked by').getByRole('link', { name: STAKER })).toBeVisible();
  await expect(row(details, 'Masternode payee')).toContainText('Unknown');
  await expect(row(details, 'Masternode payee').getByRole('link')).toHaveCount(0);
});
