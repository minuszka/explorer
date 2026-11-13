import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './apiStub';

// Every page keeps a side gutter. The main element is both a .container (side gutter) and a .page
// (vertical padding), so .page may set only its vertical padding. The header, the page and the
// footer share the gutter, and on a wide screen the content keeps its 1240 px.

async function measure(page: Page) {
  return page.evaluate(() => {
    const contentBox = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: box.left + parseFloat(style.paddingLeft),
        right: box.right - parseFloat(style.paddingRight),
        paddingLeft: parseFloat(style.paddingLeft),
        paddingRight: parseFloat(style.paddingRight),
      };
    };
    const main = contentBox(document.querySelector('main.app-main')!);
    return {
      main,
      brandLeft: document.querySelector('.header-brand')!.getBoundingClientRect().left,
      footer: contentBox(document.querySelector('.footer-inner')!),
      fits: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
}

const gutterAt = (width: number) => (width <= 768 ? 16 : width <= 1024 ? 24 : 32);

test('page content keeps a side gutter and lines up with the header and footer at every width @smoke', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.includes('mobile');
  await stubApi(page);
  // The edges of each breakpoint: 768/769 and 1024/1025 (gutter), 1080/1081 (desktop menu), 1304 (max width).
  const widths = mobile ? [page.viewportSize()!.width] : [360, 768, 769, 1024, 1025, 1080, 1081, 1239, 1280, 1304, 1440];
  for (const width of widths) {
    if (!mobile) await page.setViewportSize({ width, height: 900 });
    await page.goto('/about');
    await expect(page.locator('.page-header')).toBeVisible();
    const { main, brandLeft, footer, fits } = await measure(page);

    expect(main.paddingLeft, `left gutter at ${width} px`).toBe(gutterAt(width));
    expect(main.paddingRight, `right gutter at ${width} px`).toBe(gutterAt(width));
    expect(Math.abs(brandLeft - main.left), `header brand on the content edge at ${width} px`).toBeLessThanOrEqual(1);
    expect(Math.abs(footer.left - main.left), `footer on the content edge at ${width} px`).toBeLessThanOrEqual(1);
    expect(Math.abs(footer.right - main.right), `footer right edge at ${width} px`).toBeLessThanOrEqual(1);
    if (width >= 1304) expect(main.right - main.left, `content width at ${width} px`).toBe(1240);
    expect(fits, `no sideways scrolling at ${width} px`).toBe(true);
  }
});
