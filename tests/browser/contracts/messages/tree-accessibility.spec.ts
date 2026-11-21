// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-messages-public-ui" });
test("messages.tree-header-name-and-single-disclosure-control", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url + "/?source-ownership");
  const record = page.locator('[data-native-record="record"]');
  const header = record.locator(".otk-tool-state > .otk-tool-toggle").first();
  await expect(header).toHaveAccessibleName("Source fixture");
  await header.click();
  const source = record.locator(".otk-native-source");
  const toggle = source.getByRole("button", { name: "Source", exact: true });
  await expect(source.getByRole("button")).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(source.locator("pre")).toContainText("value 0");
  await page.keyboard.press("ArrowLeft");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await source.locator("label.otk-tree-toggle").click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toBeFocused();
});
