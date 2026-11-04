// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

const tags = { tag: ["@visual", "@menus", "@contracts"] };
async function gutters(page: Page) {
  const panel = page.locator(":popover-open.otk-popover-panel");
  await expect(panel).toBeVisible();
  await page.evaluate(() =>
    document.fonts.ready.then(() =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    )
  );
  const g = await panel.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      s = el.querySelector(".otk-surface")!.getBoundingClientRect();
    return {
      gutter: parseFloat(
        getComputedStyle(el).getPropertyValue("--popover-gutter"),
      ),
      edges: [r.left, r.top, innerWidth - r.right, innerHeight - r.bottom],
      paint: [
        s.left - r.left,
        s.top - r.top,
        s.right - r.right,
        s.bottom - r.bottom,
      ],
      size: [r.width, r.height],
    };
  });
  expect(g.size.every((n) => n > 0), JSON.stringify(g)).toBe(true);
  for (const edge of g.edges) {
    expect(edge, JSON.stringify(g)).toBeGreaterThanOrEqual(g.gutter - .5);
  }
  for (const delta of g.paint) {
    expect(Math.abs(delta), JSON.stringify(g)).toBeLessThanOrEqual(.5);
  }
  return g.gutter;
}
async function close(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(":popover-open")).toHaveCount(0);
}

test.describe("usage gutter", () => {
  test.use({ profile: "contract-messages-usage120" });
  test(
    "visual.usage-natural-size-reserves-all-viewport-gutters",
    tags,
    async ({ isolatedState: state, page }) => {
      await page.goto(state.url + "/#/local/tstv1-core");
      const trigger = page.locator(".otk-turn-usage > button");
      await expect(trigger).toContainText("120 model calls");
      await page.locator("textarea[name=prompt]").click();
      for (const [width, height, top] of [[800, 600, 396], [1280, 900, 591]]) {
        await page.setViewportSize({ width, height });
        // These valid anchor positions leave six pixels above a natural 65vh
        // panel: fitting in the viewport alone must not bypass its gutter.
        await trigger.evaluate(
          (el, top) =>
            Object.assign((el as HTMLElement).style, {
              position: "fixed",
              left: "50%",
              top: top + "px",
            }),
          top,
        );
        await trigger.focus();
        await expect(page.locator(".otk-usage-breakdown tbody tr")).toHaveCount(
          120,
        );
        await gutters(page);
        await close(page);
        await page.locator("textarea[name=prompt]").focus();
      }
    },
  );
});

test.describe("shared anchor gutters", () => {
  test.use({ profile: "contract-visual-inbox" });
  test(
    "visual.point-rect-and-trigger-popovers-reserve-all-viewport-gutters",
    tags,
    async ({ isolatedState: state, page }) => {
      await openSession(state, page, "tstv1-otk");
      for (const [width, height] of [[300, 400], [800, 600], [1280, 900]]) {
        await page.setViewportSize({ width, height });
        for (
          const [x, y] of [[1, 1], [width - 1, 1], [1, height - 1], [
            width - 1,
            height - 1,
          ], [width / 2, height / 2]]
        ) {
          await page.mouse.click(x, y, { button: "right" });
          await gutters(page);
          await close(page);
        }
        for (
          const [x, y] of [[0, 0], [width - 160, 0], [0, height - 40], [
            width - 160,
            height - 40,
          ]]
        ) {
          await page.locator(".otk-tabs-project").evaluate((el, [x, y]) => {
            const node = el as HTMLElement;
            node.tabIndex = 0;
            Object.assign(node.style, {
              position: "fixed",
              width: "160px",
              height: "40px",
              left: x + "px",
              top: y + "px",
            });
            node.focus();
          }, [x, y]);
          await page.keyboard.press("ContextMenu");
          await gutters(page);
          await close(page);
        }
        await page.locator(".otk-tabs-project").evaluate((el) =>
          el.removeAttribute("style")
        );
        const trigger = page.locator(".otk-display-menu > button");
        for (const top of [0, height / 2, height - 28]) {
          await trigger.evaluate((el, top) => {
            Object.assign((el as HTMLElement).style, {
              position: "fixed",
              left: "50%",
              top: top + "px",
            });
            (el as HTMLElement).focus();
          }, top);
          await page.keyboard.press("Enter");
          const gutter = await gutters(page);
          const anchor = (await trigger.boundingBox())!;
          const panel = (await page.locator(":popover-open.otk-popover-panel")
            .boundingBox())!;
          if (
            anchor.x + panel.width <= width - gutter ||
            anchor.x + anchor.width - panel.width >= gutter
          ) {
            expect(
              Math.abs(
                anchor.x + panel.width <= width - gutter
                  ? panel.x - anchor.x
                  : panel.x + panel.width - anchor.x - anchor.width,
              ),
            ).toBeLessThanOrEqual(.5);
          }
          await close(page);
        }
        await trigger.evaluate((el) => {
          for (const name of ["position", "left", "top"]) {
            (el as HTMLElement).style.removeProperty(name);
          }
        });
      }
    },
  );
});
