// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { selectionGeometry } from "../../../support/selection-geometry.ts";
import type { CDPSession } from "@playwright/test";
test.use({ profile: "contract-visual-inbox" });
test("visual.selection-marks-real-boxes-state-and-reduced-colours", {
  tag: ["@visual", "@isolated"],
}, async ({ isolatedState: state, page, context }) => {
  const { entries } = await state.observe<
      { entries: { id: string; directory: string }[] }
    >(),
    ids = entries.filter((e) => e.directory === state.directory).map((e) =>
      e.id
    );
  await state.product("tasks.create", {
    directory: state.directory,
    name: "Selection chain",
    sessions: ids,
  });
  await state.product("layout.patch", { rightCollapsed: false });
  await page.goto(state.url + "/#/local/tstv1-otk");
  await expect(page.locator(".otk-folded-crumbs")).toBeVisible();
  await expect(page.locator(".otk-session-row[aria-current=page]"))
    .toBeVisible();
  const cdp = await context.newCDPSession(page),
    port = {
      send: (method: string, params = {}) =>
        cdp.send(method as Parameters<CDPSession["send"]>[0], params),
    };
  const observe = async (selector: string, minimum: number) => {
    const items = await selectionGeometry(port, selector);
    expect(items.length, selector).toBeGreaterThanOrEqual(minimum);
    for (const item of items) {
      expect(item.shift).toBe(0);
      expect(item.position).toBe("static");
      if (item.orientation === "vertical") {
        expect([item.w, item.h]).toEqual([3, 14]);
        expect(item.centred).toBeLessThanOrEqual(.5);
        expect(item.start).toBe(3);
      } else {
        expect(item.h).toBe(2);
        expect([item.start, item.end, item.bottom]).toEqual([8, 8, 0]);
      }
      expect(item.paint === "rgba(0, 0, 0, 0)").toBe(!item.selected);
      if (item.ariaSelected !== null) {
        expect(item.ariaSelected === "true").toBe(item.selected);
      }
      if (item.ariaPressed !== null) {
        expect(item.ariaPressed === "true").toBe(item.selected);
      }
      if (item.ariaCurrent !== null) expect(item.ariaCurrent).toBe("page");
    }
  };
  try {
    for (const reduced of [false, true]) {
      await state.product("prefs.set", {
        key: "reducedColors",
        value: reduced,
      });
      await expect.poll(() =>
        page.locator("html").evaluate((el) =>
          el.hasAttribute("data-otk-reduced-colors")
        )
      ).toBe(reduced);
      await observe(".otk-project-inbox [data-otk-selection]", 4);
      await observe(".otk-project-sessions [data-otk-selection]", 10);
      await observe(".otk-project-tabs [data-otk-selection]", 3);
      await observe(".otk-panel-icons [data-otk-selection]", 1);
      await page.locator(".otk-folded-crumbs > button").click();
      await expect(page.locator(":popover-open")).toBeVisible();
      await observe(
        ".otk-folded-crumbs .otk-menu-items [data-otk-selection]",
        1,
      );
      await page.keyboard.press("Escape");
      await expect(page.locator(":popover-open")).toHaveCount(0);
      await page.keyboard.press("Control+k");
      await expect(page.locator("input[name=command-search]")).toBeVisible();
      await observe(".otk-palette-list [data-otk-selection]", 5);
      await page.locator("input[name=command-search]").fill("Choose theme");
      await expect(page.locator(".otk-palette-list button")).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-theme-choice][aria-pressed=true]"))
        .toBeVisible();
      await observe("[data-theme-choice]", 4);
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog")).toHaveCount(0);
    }
  } finally {
    await cdp.detach();
  }
});
