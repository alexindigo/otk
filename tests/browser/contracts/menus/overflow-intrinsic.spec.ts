// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-visual-styles" });

async function expectStartAligned(row: Locator, intrinsic = false) {
  await expect(row.locator(".otk-overflow-item:visible").first()).toBeVisible();
  const geometry = await row.evaluate((node) => {
    const items = node.querySelector(".otk-overflow-items")!;
    const measure = node.querySelector<HTMLElement>(".otk-overflow-measure")!;
    const css = getComputedStyle(measure);
    return {
      offset: Math.abs(
        items.getBoundingClientRect().left - node.getBoundingClientRect().left,
      ),
      position: css.position,
      hidden: css.visibility === "hidden" && measure.inert &&
        measure.getAttribute("aria-hidden") === "true",
      measureHeight: measure.getBoundingClientRect().height,
    };
  });
  expect.soft(geometry.offset).toBeLessThanOrEqual(0.5);
  expect(geometry.hidden).toBe(true);
  // Issue 2.120: intrinsic sizing shares the live grid track without
  // adding height. The normal overflow lane still measures out of flow.
  expect(geometry.position).toBe(intrinsic ? "relative" : "absolute");
  if (intrinsic) expect(geometry.measureHeight).toBe(0);
}

test("menus.intrinsic-revert-actions-start-at-the-row-edge", {
  tag: ["@menus", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url + "/?scene=notice-lifetime");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await page.evaluate("styleTest.settleNotice()");
  await expectStartAligned(
    page.locator(".otk-revert-group .otk-overflow-row"),
    true,
  );
});

test("menus.narrow-trail-items-start-at-the-row-edge", {
  tag: ["@menus", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto(state.url + "/?scene=lists");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  const titles = JSON.stringify(["root" + "w".repeat(100), "leaf"]);
  await page.evaluate(`styleTest.lists(${titles},'leaf')`);
  const row = page.locator(".otk-task-crumbs .otk-overflow-row");
  await expect(row).toHaveAttribute("data-fit-mode", "scroll");
  const lane = row.locator(".otk-overflow-items");
  await lane.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
  await expect.poll(() =>
    lane.evaluate((el) =>
      Math.abs(
        el.querySelector(".otk-overflow-item")!.getBoundingClientRect().left -
          el.getBoundingClientRect().left,
      )
    )
  ).toBeLessThanOrEqual(0.5);
  await expectStartAligned(row);
});
