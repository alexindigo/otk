// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-messages-public-ui" });

for (const renderer of ["activity", "task"] as const) {
  test(`messages.embedded-child-navigation-${renderer}`, {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/?child-navigation`);
    if (renderer === "activity") {
      await page.locator(".otk-record-group-heading").getByRole("button", {
        name: "Activity helper details",
      }).click();
      const action = page.getByRole("button", { name: "Open", exact: true });
      await expect(action).toBeEnabled();
      await action.click();
    } else {
      await page.locator('[data-tool="task"] .otk-tool-toggle').click();
      const action = page.getByRole("button", { name: /Open task/ });
      await expect(action).toBeEnabled();
      await action.click();
    }
    await expect(page.locator("[data-child-opens]")).toHaveText(
      renderer === "activity" ? "record-child" : "task-child",
    );
  });
}
