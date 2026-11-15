// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-messages-public-ui" });

test(
  "messages.source-preview-follows-its-single-owner-across-reference-and-record-replacement",
  { tag: ["@messages", "@contracts"] },
  async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/?source-ownership");
    const record = page.locator('[data-native-record="record"]');
    await record.locator("> .otk-tool-state > .otk-tool-toggle").click();
    const source = record.locator(".otk-native-source"),
      toggle = source.locator("> .otk-tool-toggle");
    const count = page.locator("[data-source-reads]");
    await expect(count).toHaveText("0");
    await page.getByRole("button", { name: "Update record", exact: true })
      .click();
    await expect(count).toHaveText("0");
    await toggle.click();
    await expect(source.locator("pre")).toContainText("value 1");
    await source.evaluate((node) =>
      node.setAttribute("data-source-lifetime", "kept")
    );
    await expect(count).toHaveText("1");
    await page.getByRole("button", { name: "Update record", exact: true })
      .click();
    await expect(source.locator("pre")).toContainText("value 2");
    await expect(source).toHaveAttribute("data-source-lifetime", "kept");
    await expect(count).toHaveText("2");
    await page.getByRole("button", { name: "Hold reads", exact: true }).click();
    await page.getByRole("button", { name: "Update record", exact: true })
      .click();
    await expect(count).toHaveText("3");
    await expect(source).toContainText("Loading source");
    await page.getByRole("button", { name: "Replace reference", exact: true })
      .click();
    await expect(count).toHaveText("4");
    await page.getByRole("button", { name: "Release reads", exact: true })
      .click();
    await expect(source.locator("pre")).toContainText("value 4");
    await expect(source.locator("pre")).not.toContainText("value 3");
    await toggle.click();
    await page.getByRole("button", { name: "Replace reference", exact: true })
      .click();
    await expect(count).toHaveText("4");
    await toggle.click();
    await expect(source.locator("pre")).toContainText("value 5");
    await expect(count).toHaveText("5");
  },
);
