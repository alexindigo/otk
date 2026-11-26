// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-visual-styles" });

async function expectStartAligned(row: Locator) {
  await expect(row.locator(".otk-overflow-item:visible").first()).toBeVisible();
  const geometry = await row.evaluate((node) => {
    const items = node.querySelector(".otk-overflow-items")!;
    const measure = node.querySelector(".otk-overflow-measure")!;
    return {
      offset: Math.abs(
        items.getBoundingClientRect().left - node.getBoundingClientRect().left,
      ),
      position: getComputedStyle(measure).position,
    };
  });
  expect.soft(geometry.offset).toBeLessThanOrEqual(0.5);
  expect(geometry.position).toBe("absolute");
}

test("menus.intrinsic-revert-actions-start-at-the-row-edge", {
  tag: ["@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url + "/?scene=notice-lifetime");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await page.evaluate("styleTest.settleNotice()");
  await expectStartAligned(page.locator(".otk-revert-group .otk-overflow-row"));
});

test("menus.narrow-trail-items-start-at-the-row-edge", {
  tag: ["@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto(state.url + "/?scene=lists");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  const titles = JSON.stringify(["root" + "w".repeat(100), "leaf"]);
  await page.evaluate(`styleTest.lists(${titles},'leaf')`);
  const row = page.locator(".otk-task-crumbs .otk-overflow-row");
  await expect(row).toHaveAttribute("data-fit-mode", "compact");
  await expectStartAligned(row);
});
