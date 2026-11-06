// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";

/** Public component galleries may flow in a document. The application never does. */
export async function shellContained(page: Page) {
  if (!await page.locator(".otk-app").count()) return;
  expect(
    await page.evaluate(() => {
      const root = document.scrollingElement!;
      return [root.scrollHeight, root.scrollWidth, scrollX, scrollY];
    }),
  ).toEqual(await page.evaluate(() => [innerHeight, innerWidth, 0, 0]));
  expect(
    await page.locator(".otk-app").evaluate((app) => {
      return Array.from(app.querySelectorAll("*")).flatMap((el) => {
        const css = getComputedStyle(el);
        return [[css.overflowX, css.overscrollBehaviorX], [
            css.overflowY,
            css.overscrollBehaviorY,
          ]].some(([overflow, overscroll]) =>
            (overflow === "auto" || overflow === "scroll") &&
            (!el.classList.contains("otk-scroll") || overscroll !== "contain")
          )
          ? [el.tagName + "." + el.className]
          : [];
      });
    }),
  ).toEqual([]);
}

/** Real wheel input at both sidebar boundaries must not chain to another region. */
export async function sidebarWheelContained(page: Page) {
  const body = page.locator(".otk-project-inbox .otk-rail-body");
  const position = await body.evaluate((el) => [el.scrollLeft, el.scrollTop]);
  for (const edge of ["top", "bottom"] as const) {
    await body.evaluate((el, edge) => {
      el.scrollTop = edge === "top" ? 0 : el.scrollHeight;
    }, edge);
    const before = await body.evaluate((el) => [el.scrollLeft, el.scrollTop]);
    const box = (await body.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, edge === "top" ? -800 : 800);
    await page.evaluate(() =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      })
    );
    expect(await body.evaluate((el) => [el.scrollLeft, el.scrollTop])).toEqual(
      before,
    );
    await shellContained(page);
  }
  await body.evaluate((el, [left, top]) => el.scrollTo(left, top), position);
}
