// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-themes" });

test("visual.public-pane-mounts-the-shared-disclosure-owner", {
  tag: ["@visual", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  const { scenes } = await state.observe<{ scenes: string }>();
  await page.goto(`${scenes}/?server=${encodeURIComponent(state.url)}`);
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  const error = page.locator('[data-pane="error"]').getByRole("alert");
  const details = error.getByRole("button", { name: "Details", exact: true });
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  const body = error.getByRole("group");
  await expect(body).toContainText("No diagnostic ID supplied");
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(body).toHaveCount(0);
});
