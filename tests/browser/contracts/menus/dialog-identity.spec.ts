// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { Page } from "@playwright/test";

test.use({ profile: "contract-menus-dialog" });
test.beforeEach(async ({ isolatedState: state, page }) => {
  await page.goto(state.url);
  await page.locator("#origin").click();
});
const events = (page: Page) => page.evaluate<string[]>("dialogTest.events");
const input = (page: Page) => page.locator("dialog[open] input[name=taskName]");
for (const query of ["", "Consumer action"]) {
  test(`menus.palette-availability-query-${query ? "filtered" : "empty"}`, {
    tag: ["@menus", "@isolated"],
  }, async ({ page }) => {
    await page.evaluate("dialogTest.available(false);dialogTest.palette()");
    const search = page.locator("input[name=command-search]");
    await search.fill(query);
    const action = page.locator('[data-command="consumer.action"]');
    await expect(action).toHaveCount(0);
    await expect(page.locator(".otk-palette-list button:disabled")).toHaveCount(
      0,
    );
    await page.evaluate("dialogTest.available(true)");
    await expect(action).toBeEnabled();
    await page.evaluate("dialogTest.available(false)");
    await expect(action).toHaveCount(0);
    await search.fill("");
    await expect(action).toHaveCount(0);
    await page.evaluate("dialogTest.available(true)");
    await action.click();
    await expect(search).toHaveCount(0);
    expect(await events(page)).toEqual(["action", "palette:closed"]);
  });
}
test("menus.same-type-task-replacement-owns-form-save-and-focus", {
  tag: ["@menus", "@isolated"],
}, async ({ page }) => {
  await page.evaluate("dialogTest.task('First task')");
  await input(page).fill("Unsaved first edit");
  await page.evaluate("dialogTest.task('Second task')");
  await expect(input(page)).toHaveValue("Second task");
  await input(page).fill("Second edit");
  await page.locator("button[type=submit]").click();
  await expect.poll(() => events(page)).toEqual([
    "save:Second task:Second edit",
  ]);
  await page.evaluate("dialogTest.finish()");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator("#origin")).toBeFocused();
});
test("menus.late-task-save-preserves-replacement", {
  tag: ["@menus", "@isolated"],
}, async ({ page }) => {
  await page.evaluate("dialogTest.task('Saving task')");
  await input(page).waitFor();
  await page.locator("button[type=submit]").click();
  await expect.poll(() => events(page)).toContain(
    "save:Saving task:Saving task",
  );
  await page.evaluate("dialogTest.task('Replacement task')");
  await expect(input(page)).toHaveValue("Replacement task");
  await page.evaluate("dialogTest.finish()");
  await expect.poll(() => events(page)).toContain("saved:Saving task");
  // The injected save finished; observe its caller's ensuing rendered close
  // decision before judging whether the replacement survived that completion.
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  await expect(input(page)).toHaveValue("Replacement task");
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator("#origin")).toBeFocused();
});
test("menus.dialog-invocation-content-dismiss-teardown-and-close-handles", {
  tag: ["@menus", "@isolated"],
}, async ({ page }) => {
  await page.evaluate(
    "dialogTest.probe('First').then(handle=>globalThis.firstDialog=handle)",
  );
  await expect.poll(() => events(page)).toContain("mount:First");
  await page.evaluate("dialogTest.probe('Second')");
  await expect(page.getByRole("dialog", { name: "Second", exact: true }))
    .toBeVisible();
  expect(await events(page)).toEqual([
    "mount:First",
    "dispose:First",
    "mount:Second",
  ]);
  expect(await page.evaluate("dialogTest.inputs[0]()")).toBe("First");
  await page.evaluate("firstDialog.close();dialogTest.closes[0]()");
  await expect(page.getByRole("dialog", { name: "Second", exact: true }))
    .toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => events(page)).toContain("dismiss:Second");
  await expect(page.getByRole("dialog", { name: "Second", exact: true }))
    .toBeVisible();
  await page.evaluate("dialogTest.task('Different type')");
  await expect(input(page)).toHaveValue("Different type");
  await page.evaluate("dialogTest.closes[1]();firstDialog.close()");
  await expect(input(page)).toHaveValue("Different type");
  await page.evaluate("dialogTest.close()");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});
test("menus.deferred-feature-dismissal-is-invocation-bound", {
  tag: ["@menus", "@isolated"],
}, async ({ page }) => {
  await page.evaluate("dialogTest.probe('First dismissal')");
  await expect(
    page.getByRole("dialog", { name: "First dismissal", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate("dialogTest.dismissCloses.length"))
    .toBe(1);
  await page.evaluate("dialogTest.dismissCloses[0]()");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.evaluate("dialogTest.probe('Deferred dismissal')");
  await expect(
    page.getByRole("dialog", { name: "Deferred dismissal", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate("dialogTest.dismissCloses.length"))
    .toBe(2);
  await page.evaluate("dialogTest.probe('Replacement dismissal')");
  const replacement = page.getByRole("dialog", {
    name: "Replacement dismissal",
    exact: true,
  });
  await expect(replacement).toBeVisible();
  await page.evaluate("dialogTest.dismissCloses[1]()");
  await expect(replacement).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate("dialogTest.dismissCloses.length"))
    .toBe(3);
  await page.evaluate("dialogTest.dismissCloses[2]()");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});
test("menus.standalone-palette-injected-close-callback", {
  tag: ["@menus", "@isolated"],
}, async ({ page }) => {
  await page.evaluate("dialogTest.palette()");
  await page.locator('[data-command="consumer.action"]').click();
  await expect.poll(() => events(page)).toEqual(["action", "palette:closed"]);
  await expect(page.locator("input[name=command-search]")).toHaveCount(0);
});
