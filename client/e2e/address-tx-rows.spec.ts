import { expect, test } from '@playwright/test';
import { stubApi } from './apiStub';

// One label per transaction on both pages, and one compact line per transaction on an address page.

const BLOCK_TIME = 1_788_609_600; // 2026-09-05 12:00:00 UTC
const STAKER = `D${'K'.repeat(33)}`;
const OTHER = `D${'O'.repeat(33)}`;
const STAKE = 'a'.repeat(64);
const REWARD = 'b'.repeat(64);
const SELF = 'c'.repeat(64);
const MEMO = 'd'.repeat(64);
const BURN = 'e'.repeat(64);

const sat = (value: number) => String(Math.round(value * 1e8));
const output = (n: number, value: number, type: string, address?: string) => ({
  n, value, valueSat: sat(value), scriptPubKey: { asm: '', hex: '', type, addresses: address ? [address] : [] },
});
const input = (value: number, address: string) => ({ txid: 'f'.repeat(64), vout: 1, sequence: 0, address, value, valueSat: sat(value) });
const totals = (valueIn: number, valueOut: number, fee: number) => ({
  totalValueIn: valueIn, totalValueOut: valueOut, fee,
  totalValueInSat: sat(valueIn), totalValueOutSat: sat(valueOut), feeSat: sat(fee),
});
const base = (txid: string, height: number) => ({
  txid, blockhash: '9'.repeat(64), blockheight: height, blocktime: BLOCK_TIME - (200 - height) * 60,
  version: 3, size: 200, locktime: 0, confirmations: 201 - height, donationAmount: 0, isDonation: false,
});

// Shaped like the chain, as /api/tx/<txid> returns them.
const TXS = {
  // A stake spends 25,375 DFCN back to the same address with an empty "nonstandard" first output.
  [STAKE]: {
    ...base(STAKE, 200), isCoinbase: false, ...totals(25_375, 25_875, 0),
    vin: [input(25_375, STAKER)],
    vout: [output(0, 0, 'nonstandard'), output(1, 25_875, 'pubkey', STAKER)],
  },
  // A block reward has a coinbase input and the same empty first output.
  [REWARD]: {
    ...base(REWARD, 199), isCoinbase: true, ...totals(0, 10_000, 0),
    vin: [{ coinbase: '03aa0d02', sequence: 0, value: 0, valueSat: '0' }],
    vout: [output(0, 0, 'nonstandard'), output(1, 10_000, 'pubkeyhash', STAKER)],
  },
  // A consolidation pays everything back to the address minus the fee.
  [SELF]: {
    ...base(SELF, 198), isCoinbase: false, ...totals(100, 99.9999, 0.0001),
    vin: [input(100, STAKER)],
    vout: [output(0, 99.9999, 'pubkeyhash', STAKER)],
  },
  // A payment that starts with a zero-value OP_RETURN note: not a stake, though it looks like one.
  [MEMO]: {
    ...base(MEMO, 197), isCoinbase: false, ...totals(50, 49.9999, 0.0001),
    vin: [input(50, STAKER)],
    vout: [output(0, 0, 'nulldata'), output(1, 10, 'pubkeyhash', OTHER), output(2, 39.9999, 'pubkeyhash', STAKER)],
  },
  // 10 DFCN go to an output without an address: the change comes back, but this is not a self transfer.
  [BURN]: {
    ...base(BURN, 196), isCoinbase: false, ...totals(100, 99.9999, 0.0001),
    vin: [input(100, STAKER)],
    vout: [output(0, 89.9999, 'pubkeyhash', STAKER), output(1, 10, 'nulldata')],
  },
};

type FullTx = (typeof TXS)[string];

/**
 * What /api/address/<address>/txs returns for a transaction: only the fields of its projection, and
 * at most one address per output. `withTypes: false` is a list from before output types were added.
 */
function listShape(tx: FullTx, { withTypes = true } = {}) {
  return {
    txid: tx.txid, blockheight: tx.blockheight, blocktime: tx.blocktime, isCoinbase: tx.isCoinbase,
    totalValueIn: tx.totalValueIn, totalValueOut: tx.totalValueOut, fee: tx.fee,
    totalValueInSat: tx.totalValueInSat, totalValueOutSat: tx.totalValueOutSat, feeSat: tx.feeSat,
    donationAmount: 0, isDonation: false, confirmations: tx.confirmations,
    vin: tx.vin.map((vin) => ({ ...('address' in vin ? { address: vin.address } : {}), valueSat: vin.valueSat, value: vin.value })),
    vout: tx.vout.map((vout) => ({
      valueSat: vout.valueSat, value: vout.value,
      scriptPubKey: { ...(withTypes ? { type: vout.scriptPubKey.type } : {}), addresses: vout.scriptPubKey.addresses.slice(0, 1) },
    })),
  };
}

const ORDER = [STAKE, REWARD, SELF, MEMO, BURN];

function stubAddress({ withTypes = true } = {}) {
  return {
    [`/api/address/${STAKER}`]: {
      success: true,
      data: { address: STAKER, balance: 35_904.9998, totalReceived: 36_154.9997, totalSent: 250, txCount: ORDER.length,
        balanceSat: sat(35_904.9998), totalReceivedSat: sat(36_154.9997), totalSentSat: sat(250) },
    },
    [`/api/address/${STAKER}/txs`]: {
      success: true,
      data: ORDER.map((txid) => listShape(TXS[txid], { withTypes })),
      pagination: { page: 1, limit: 20, total: ORDER.length, pages: 1 },
    },
    ...Object.fromEntries(Object.entries(TXS).map(([txid, tx]) => [`/api/tx/${txid}`, { success: true, data: tx }])),
  };
}

test('a stake and a block reward carry the same label on both pages, and a transfer reads from the address side @smoke', async ({ page }) => {
  await stubApi(page, stubAddress());

  await page.goto(`/address/${STAKER}`);
  const rows = page.locator('.address-tx-row');
  await expect(rows).toHaveCount(ORDER.length);
  // The OP_RETURN payment is no stake, and change coming back does not make a payment a self transfer.
  await expect(rows.locator('.address-tx-row-kind')).toHaveText(['Stake', 'Reward', 'Self', 'Sent', 'Sent']);
  await expect(rows.locator('.address-tx-row-amount'))
    .toHaveText(['+500 DFCN', '+10,000 DFCN', '-0.0001 DFCN', '-10.0001 DFCN', '-10.0001 DFCN']);
  await expect(rows.first().locator('.address-tx-row-time time')).toHaveText('2026-09-05 12:00:00 UTC');

  // Without an address to look from, the payments are plain transfers.
  for (const [txid, label] of [[STAKE, 'Stake'], [REWARD, 'Reward'], [SELF, 'Transfer'], [MEMO, 'Transfer'], [BURN, 'Transfer']] as const) {
    await page.goto(`/tx/${txid}`);
    await expect(page.locator('.searchv2-flow-meta .badge').first()).toHaveText(label);
    const details = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Details' }) });
    await expect(details.locator('.detail-row').filter({ hasText: 'Type' }).locator('.badge')).toHaveText(label);
  }

  // The empty first output reads the same on the transaction page and in the address page's flow.
  await page.goto(`/tx/${STAKE}`);
  const txOutputs = page.locator('.searchv2-flow-card .searchv2-flow-column').nth(1);
  await expect(txOutputs.locator('.searchv2-flow-node').first()).toContainText('nonstandard');
  await page.goto(`/address/${STAKER}`);
  const stakeRow = page.locator('.address-tx-row').first();
  await stakeRow.getByRole('button', { name: /^Show the flow of transaction/ }).click();
  const rowOutputs = stakeRow.locator('.searchv2-flow-column').nth(1);
  await expect(rowOutputs.locator('.searchv2-flow-node').first()).toContainText('nonstandard');
});

test('an address list without output types never shows a stake @smoke', async ({ page }) => {
  // A list from before output types were sent: the empty first output's type is unknown.
  await stubApi(page, stubAddress({ withTypes: false }));

  await page.goto(`/address/${STAKER}`);
  const rows = page.locator('.address-tx-row');
  await expect(rows).toHaveCount(ORDER.length);
  await expect(rows.locator('.address-tx-row-kind')).toHaveText(['Self', 'Reward', 'Self', 'Sent', 'Sent']);
});

test('any value sent to an output without an address, down to one satoshi, makes a transfer a send @smoke', async ({ page }) => {
  // 100 DFCN in, a 0.0001 DFCN fee, and 0, 1, 10 or 11 satoshi to an OP_RETURN output; the rest comes back.
  const DUSTER = `D${'U'.repeat(33)}`;
  const dust = (sats: number, n: number) => {
    const txid = String(n).repeat(64);
    const note = sats / 1e8;
    return {
      ...base(txid, 190 - n), isCoinbase: false, ...totals(100, 99.9999, 0.0001),
      vin: [input(100, DUSTER)],
      vout: [output(0, 99.9999 - note, 'pubkeyhash', DUSTER), output(1, note, 'nulldata')],
    };
  };
  const txs = [dust(0, 1), dust(1, 2), dust(10, 3), dust(11, 4)];
  await stubApi(page, {
    [`/api/address/${DUSTER}/txs`]: {
      success: true,
      data: txs.map((tx) => listShape(tx)),
      pagination: { page: 1, limit: 20, total: txs.length, pages: 1 },
    },
  });

  await page.goto(`/address/${DUSTER}`);
  const rows = page.locator('.address-tx-row');
  await expect(rows).toHaveCount(txs.length);
  await expect(rows.locator('.address-tx-row-kind')).toHaveText(['Self', 'Sent', 'Sent', 'Sent']);
  await expect(rows.locator('.address-tx-row-amount'))
    .toHaveText(['-0.0001 DFCN', '-0.00010001 DFCN', '-0.0001001 DFCN', '-0.00010011 DFCN']);
});

test('an address row opens its flow from the keyboard and shows the real input total @smoke', async ({ page }) => {
  await stubApi(page, stubAddress());
  await page.goto(`/address/${STAKER}`);

  const row = page.locator('.address-tx-row').first();
  // Its name says what it will do next, so find it by its place, not by its name.
  const toggle = row.locator('.address-tx-row-toggle');
  await expect(toggle).toHaveAccessibleName(/^Show the flow of transaction aaaaaaaa/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const flowId = await toggle.getAttribute('aria-controls');
  expect(flowId).toBeTruthy();
  const flow = page.locator(`[id="${flowId}"]`);
  await expect(flow).toBeHidden();

  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAccessibleName(/^Hide the flow of transaction/);
  await expect(flow).toBeVisible();
  // The stake spent one 25,375 DFCN output; the footer adds up the same.
  const metric = (label: string) => flow.locator('.searchv2-flow-metric').filter({ hasText: label });
  await expect(metric('Total in')).toHaveText('Total in: 25,375 DFCN');
  await expect(metric('Net on this address')).toHaveText('Net on this address: +500 DFCN');
  // The row already names the transaction, so the opened flow drops the header but keeps its confirmations.
  await expect(flow.locator('.searchv2-flow-header')).toHaveCount(0);
  await expect(metric('Confirmations')).toHaveText('Confirmations: 1');

  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(flow).toBeHidden();
});

test('an address row keeps its amount on screen at every width @smoke', async ({ page }, testInfo) => {
  await stubApi(page, stubAddress());
  await page.goto(`/address/${STAKER}`);

  const row = page.locator('.address-tx-row').first();
  const amount = row.locator('.address-tx-row-amount');
  await expect(amount).toBeVisible();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('No viewport');
  const [amountBox, blockBox] = await Promise.all([amount.boundingBox(), row.locator('.address-tx-row-block').boundingBox()]);
  if (!amountBox || !blockBox) throw new Error('Row parts were not rendered');
  expect(amountBox.x + amountBox.width).toBeLessThanOrEqual(viewport.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  if (testInfo.project.name === 'mobile-chromium') {
    // On a phone the row breaks in two: label, txid and amount first, block and time below.
    expect(blockBox.y).toBeGreaterThan(amountBox.y + amountBox.height / 2);
  } else {
    // On a desktop it is one line.
    expect(Math.abs(blockBox.y + blockBox.height / 2 - (amountBox.y + amountBox.height / 2))).toBeLessThan(4);
  }
});
