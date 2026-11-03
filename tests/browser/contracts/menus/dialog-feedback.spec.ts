// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-messages-public-ui" });
test("menus.public-dialog-pending-rejection-retains-form-and-visible-focus", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url + "/?layout-controls");
  await page.locator("[data-dark]").click();
  await page.locator("[data-task]").click();
  const dialog = page.locator("dialog[open]"),
    input = dialog.locator("input[name=taskName]");
  await input.fill("Retained task name");
  const boxes = () =>
    dialog.evaluate((el) =>
      ["h2", "input[name=taskName]", ".otk-action-slot"].flatMap((selector) => {
        const r = el.querySelector(selector)!.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      })
    );
  const idle = await boxes();
  await dialog.locator("button[type=submit]").click();
  await expect(dialog.locator("form")).toHaveAttribute("aria-busy", "true");
  const pending = await boxes();
  expect(pending.every((v, n) => Math.abs(v - idle[n]) <= 1)).toBe(true);
  await expect(dialog.locator("[disabled]")).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const el = document.activeElement!;
      return !!el.getBoundingClientRect().width &&
        getComputedStyle(el).visibility !== "hidden";
    }),
  ).toBe(true);
  await page.locator("[data-reject]").evaluate((el) =>
    (el as HTMLElement).click()
  );
  await expect(dialog.getByRole("alert")).toHaveCount(1);
  const error = await boxes();
  expect(error.every((v, n) => Math.abs(v - idle[n]) <= 1)).toBe(true);
  await expect(input).toHaveValue("Retained task name");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
