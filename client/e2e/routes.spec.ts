import { expect, test } from '@playwright/test';
import { stubApi } from './apiStub';

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

test('direct operator and information URLs load their route shells @smoke', async ({ page }) => {
  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About DeFCoN' })).toBeVisible();

  await page.goto('/chain-health');
  await expect(page.getByRole('heading', { name: 'Nodes', exact: true, level: 1 })).toBeVisible();

  await page.goto('/devtools/node-inventory');
  await expect(page.getByRole('heading', { name: 'Node Version & Chain Inventory' })).toBeVisible();

  await page.goto('/ban-detection');
  await expect(page.getByRole('heading', { name: 'PoSe Watch' })).toBeVisible();
});

test('API documentation is derived from the live OpenAPI contract @smoke', async ({ page }) => {
  await page.unroute('**/api/**');
  await stubApi(page, {
    '/api/docs/openapi.json': {
      openapi: '3.0.3',
      info: {
        title: 'DeFCoN Explorer API',
        version: '1.0.0',
        description: 'API fixture generated from the OpenAPI contract.',
      },
      tags: [
        { name: 'Stats', description: 'Global chain statistics' },
        { name: 'Search', description: 'Universal lookup' },
      ],
      paths: {
        '/api/stats': {
          get: {
            tags: ['Stats'],
            summary: 'Global chain statistics',
            responses: {
              200: {
                description: 'Successful response',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/StatsApiResponse' },
                  },
                },
              },
            },
          },
        },
        '/api/search': {
          get: {
            tags: ['Search'],
            summary: 'Search by block, transaction, or address',
            parameters: [
              {
                name: 'q',
                in: 'query',
                required: true,
                description: 'Lookup value',
                schema: { type: 'string', minLength: 1 },
              },
            ],
            responses: {
              200: {
                description: 'Successful response',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/SearchApiResponse' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          StatsApiResponse: {
            type: 'object',
            required: ['success', 'data'],
            properties: { success: { type: 'boolean' }, data: { type: 'object' } },
          },
          SearchApiResponse: {
            type: 'object',
            required: ['success', 'data'],
            properties: { success: { type: 'boolean' }, data: { type: 'object' } },
          },
        },
      },
    },
  });

  await page.goto('/about');
  const menuButton = page.getByRole('button', { name: 'Open menu' });
  if (await menuButton.isVisible()) await menuButton.click();
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'API', exact: true }).click();
  await expect(page).toHaveURL(/\/api$/);
  await expect(page.getByRole('heading', { name: 'API Documentation' })).toBeVisible();
  await expect(page.getByLabel('API document summary')).toContainText('2 endpoints');
  await expect(page.getByRole('tab', { name: /Stats 1/ })).toBeVisible();
  await expect(page.getByText('/api/stats', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Response contract (200)' }).click();
  await expect(page.locator('.api-code-block')).toContainText('StatsApiResponse');

  await page.getByRole('tab', { name: /Search 1/ }).click();
  await expect(page.getByText('/api/search', { exact: true })).toBeVisible();
  await expect(page.getByText('Query parameters', { exact: true })).toBeVisible();
  await expect(page.getByText('required', { exact: true })).toBeVisible();
});
