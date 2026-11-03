// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { contextMenu, rightClick } from "../../pages/menus.ts";

test.use({ profile: "contract-menus-context" });
test("menus.confirmation-survives-unrelated-command-owners", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url);
  await rightClick(page, "#confirm-target");
  await expect(contextMenu(page)).toBeFocused();
  const action = contextMenu(page).locator(
    '[data-context-command="probe.destroy"]',
  );
  await action.click();
  await expect(action).toHaveText("Press again to destroy");
  // Programmatic control activation changes only registry ownership: no pointer
  // or focus transition may explain a lost confirmation in this scenario.
  await page.locator("#mount-transcript").evaluate((el) =>
    (el as HTMLElement).click()
  );
  await expect(page.locator("#context-command-count")).not.toHaveText("0");
  await expect(action).toHaveClass(/is-armed/);
  await page.locator("#release-inner").evaluate((el) =>
    (el as HTMLElement).click()
  );
  await expect(action).toHaveClass(/is-armed/);
  await page.locator("#change-confirmation").evaluate((el) =>
    (el as HTMLElement).click()
  );
  await expect(action).toHaveText("Destroy probe");
  await action.click();
  await expect(action).toHaveText("Press again to destroy changed probe");
  await action.click();
  await expect(page.locator("#result")).toHaveText("destroyed");
  await expect(contextMenu(page)).toHaveCount(0);
  await rightClick(page, "#confirm-target");
  await expect(contextMenu(page)).toBeFocused();
  await action.click();
  await expect(action).toHaveClass(/is-armed/);
  await page.locator("#replace-confirmation").evaluate((el) =>
    (el as HTMLElement).click()
  );
  await expect(action).toHaveText("Destroy probe");
  await action.click();
  await expect(action).toHaveText("Press again to destroy changed probe");
  await expect(page.locator("#result")).toHaveText("destroyed");
  await page.locator("#release-confirmation").evaluate((el) =>
    (el as HTMLElement).click()
  );
  await expect(contextMenu(page)).toHaveCount(0);
});
