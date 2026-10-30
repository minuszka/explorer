import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { stubApi } from './apiStub';

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

function readGit(args: string[]): string {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

test('footer shows the built commit with its UTC commit time @smoke', async ({ page }) => {
  // The preview server builds from this checkout, so the footer must match its HEAD.
  const shortHash = readGit(['rev-parse', '--short', 'HEAD']);
  const commitDate = new Date(readGit(['log', '-1', '--format=%cI'])).toISOString();

  await page.goto('/about');
  await expect(page.locator('.footer-build-hash')).toContainText(`Commit ${shortHash} · `);
  const committed = page.locator('.footer-build-commit-date time');
  await expect(committed).toHaveAttribute('datetime', commitDate);
  await expect(committed).toContainText(`${commitDate.slice(0, 4)}, ${commitDate.slice(11, 16)} UTC`);
});
