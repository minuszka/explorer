import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';
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

test.describe('when the build cannot read git', () => {
  // The values are fixed at build time, so this needs its own build; one viewport is enough for the text.
  test.skip(({ isMobile }) => isMobile, 'Desktop only');

  let server: PreviewServer | undefined;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const info = test.info();
    const root = path.dirname(info.project.testDir);
    const outDir = info.outputPath('dist');
    // Every git command fails with a git directory that does not exist, as in a copy without .git.
    // The build runs in this worker, so a stuck build ends with the worker and leaves no process behind.
    const gitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = info.outputPath('no-such-git-dir');
    try {
      await build({ root, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    } finally {
      if (gitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = gitDir;
    }
    server = await preview({ root, logLevel: 'silent', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  });

  test.afterAll(async () => {
    await server?.close();
  });

  test('footer says the commit is unknown @smoke', async ({ page }) => {
    await page.goto(new URL('/about', server!.resolvedUrls!.local[0]).href);
    await expect(page.locator('.footer-build-hash')).toHaveText('Commit nogit · unknown commit');
    const committed = page.locator('.footer-build-commit-date');
    await expect(committed).toHaveText('Committed unknown');
    await expect(committed.locator('time')).toHaveCount(0);
  });
});
