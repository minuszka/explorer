import { expect, type Locator, type Page } from '@playwright/test';

/** The header search field, also while its phone row is closed (role queries skip hidden elements). */
export function headerSearchField(page: Page): Locator {
  return page.locator('header #header-search-input');
}

/** The site-wide search field; on a phone it first opens from the header's search button. */
export async function openHeaderSearch(page: Page): Promise<Locator> {
  const toggle = page.getByRole('button', { name: 'Open search' });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.locator('header').getByRole('searchbox', { name: 'Search the explorer' })).toBeVisible();
  return headerSearchField(page);
}
