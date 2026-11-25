// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";

export const subagents = (page: Page) =>
  page.getByRole("button", { name: /^Subagents:/ });

export const subagent = (page: Page, id: string) =>
  page.locator(`.otk-subagents [data-subagent=${JSON.stringify(id)}]`);

export async function openBlockedSubagents(page: Page) {
  // The permission takeover covers the input rail. Dismiss only its surface;
  // the still-pending native request must keep the helper's blocked lamp.
  await page.locator(".otk-permission-dock").getByRole("button", {
    name: "Dismiss locally",
    exact: true,
  }).click();
  await subagents(page).click();
}

export async function restorePermissionDock(page: Page) {
  const reopen = page.getByRole("button", {
    name: "Pending permission: reopen",
    exact: true,
  });
  const dock = page.locator(".otk-permission-dock");
  await expect(dock.or(reopen)).toBeVisible();
  if (await reopen.isVisible()) await reopen.click();
  await expect(dock).toBeVisible();
}

export function assertCrumbCoverage(
  ancestry: readonly string[],
  shown: string[],
  inventory: string[],
  helpers: readonly string[] = [],
) {
  // D67: no ancestor may disappear into D66's independently owned inventory.
  expect(shown).toEqual(ancestry);
  expect(inventory).toEqual(helpers);
}
