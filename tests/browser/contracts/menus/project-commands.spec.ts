// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-menus-content" });
test("menus.retired-project-command-keeps-mutation-without-late-navigation", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  await page.locator(".otk-sidebar-commands button").first().click();
  await page.locator("input[name=command-search]").fill("task.rename");
  await page.locator('[data-command^="task.rename@"]').click();
  const dialog = page.getByRole("dialog", { name: "New task", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.locator("input[name=taskName]").fill("Original project task");
  // Address-bar/history navigation may replace a project beneath a modal.
  await page.evaluate(() => {
    location.hash = "#/local/tstv1-atmosphera";
  });
  await expect(page.locator('[data-crumb="tstv1-atmosphera"]')).toBeVisible();
  const target = page.url();
  await dialog.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(async () => {
    const inbox = await state.product("inbox.get", {});
    const task = inbox.inbox.tasks.find((task) =>
      task.name === "Original project task"
    );
    return task?.directory.endsWith("/projects/otk");
  }).toBe(true);
  await expect(dialog).toHaveCount(0);
  expect(page.url()).toBe(target);
  // A still-current owner must retain the normal create-and-select behavior.
  await page.locator(".otk-sidebar-commands button").first().click();
  await page.locator("input[name=command-search]").fill("task.rename");
  await page.locator('[data-command^="task.rename@"]').click();
  await expect(dialog).toBeVisible();
  await dialog.locator("input[name=taskName]").fill("Current project task");
  await dialog.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(target);
  await expect(page.locator(".otk-project-tabs")).toContainText(
    "Current project task",
  );
});
