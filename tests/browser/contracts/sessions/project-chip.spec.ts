// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-visual-inbox" });
test("sessions.project-chip-hides-unreported-native-facts", {
  tag: ["@sessions", "@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  const chip = page.locator(".otk-project-chip-trigger");
  await expect(chip).toBeVisible();
  await expect(chip.locator(".otk-project-avatar")).toHaveText("O");
  await chip.click();
  const menu = page.locator(".otk-project-chip-menu :popover-open").first();
  await expect(menu.getByRole("heading").locator(".otk-control-label"))
    .toHaveText("otk");
  await expect(menu.locator(".otk-project-chip-menu-row:visible")).toHaveCount(
    1,
  );
  await expect(menu.locator("[disabled],[aria-disabled=true]")).toHaveCount(0);
  await expect(menu.getByText("No changes", { exact: true })).toHaveCount(0);
  await expect(menu.getByText("This server", { exact: true })).toHaveCount(0);
  await expect(menu.getByText("Edit project", { exact: true })).toHaveCount(0);
});
