// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { contextMenu, dismiss, menuLabels } from "../../pages/menus.ts";

test.use({ profile: "contract-menus-inbox" });
test("menus.visible-content-density-and-pointer-placement", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await page.goto(state.url);
  await expect(page.locator(".otk-welcome")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    for (const area of [".otk-welcome", ".otk-project-inbox"]) {
      const bounds = (await page.locator(area).boundingBox())!;
      const point = { x: bounds.x + 32, y: bounds.y + 120 };
      await page.mouse.click(point.x, point.y, { button: "right" });
      const labels = await menuLabels(page);
      if (area === ".otk-welcome") {
        expect(labels).toEqual(["Open command palette", "Display preferences"]);
      }
      const geometry = await contextMenu(page).evaluate((menu) => {
        const surface = menu.closest(".otk-surface")!;
        const body = menu.closest(".otk-surface-body")!;
        const rect = surface.getBoundingClientRect();
        const style = getComputedStyle(surface);
        const token = (name: string) =>
          parseFloat(style.getPropertyValue(name));
        const rows = Array.from(menu.querySelectorAll('[role="menuitem"]'));
        const heights = rows.map((row) => row.getBoundingClientRect().height);
        const separators = Array.from(menu.querySelectorAll("hr"))
          .reduce((sum, row) => {
            const css = getComputedStyle(row);
            return sum + row.getBoundingClientRect().height +
              parseFloat(css.marginTop) + parseFloat(css.marginBottom);
          }, 0);
        return {
          x: rect.x,
          y: rect.y,
          height: rect.height,
          expected: heights.reduce((sum, height) => sum + height, 0) +
            separators + 2 * token("--menu-block-inset") +
            parseFloat(style.borderTopWidth) +
            parseFloat(style.borderBottomWidth),
          heights,
          rowHeight: token("--menu-row-height"),
          padding: [
            style.paddingTop,
            style.paddingRight,
            style.paddingBottom,
            style.paddingLeft,
          ],
          bodyPadding: getComputedStyle(body).padding,
          hidden: rows.filter((row) =>
            getComputedStyle(row).visibility === "hidden"
          ).length,
          emptyFeedback:
            body.querySelectorAll(':scope > [aria-hidden="true"]').length,
        };
      });
      await info.attach(`${theme}-${area}-geometry`, {
        body: JSON.stringify({ point, labels, ...geometry }),
        contentType: "application/json",
      });
      await info.attach(`${theme}-${area}-full`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      expect(Math.abs(geometry.height - geometry.expected)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(geometry.x - point.x)).toBeLessThanOrEqual(.5);
      expect(Math.abs(geometry.y - point.y)).toBeLessThanOrEqual(.5);
      expect(
        geometry.heights.every((height) =>
          Math.abs(height - geometry.rowHeight) <= 1
        ),
      ).toBe(true);
      expect(geometry.padding).toEqual(["4px", "8px", "4px", "8px"]);
      expect(geometry.bodyPadding).toBe("0px");
      expect(geometry.hidden).toBe(0);
      expect(geometry.emptyFeedback).toBe(0);
      await dismiss(page);
    }
  }
});
