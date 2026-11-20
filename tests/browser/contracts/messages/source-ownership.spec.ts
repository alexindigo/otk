// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { recordToggle } from "../../pages/transcript.ts";
test.use({ profile: "contract-messages-public-ui" });

test(
  "messages.source-preview-follows-its-single-owner-across-reference-and-record-replacement",
  { tag: ["@messages", "@contracts"] },
  async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/?source-ownership");
    const record = page.locator('[data-native-record="record"]');
    await recordToggle(record).click();
    const source = record.locator(".otk-native-source"),
      toggle = source.getByRole("button", { name: "Source", exact: true });
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

    // An absent provider is one failure, not one occurrence per render read.
    // Without a resource owner there is also no Retry operation to offer.
    await page.goto(state.url + "/?source-ownership&missing-source-reader");
    const missingRecord = page.locator('[data-native-record="record"]');
    await recordToggle(missingRecord).click();
    const missingSource = missingRecord.locator(".otk-native-source");
    const missingToggle = missingSource.getByRole("button", {
      name: "Source",
      exact: true,
    });
    await missingToggle.click();
    await expect(missingSource).toContainText("This view has no source reader");
    await expect(missingSource).not.toContainText("identical failures");
    await missingToggle.click();
    await missingToggle.click();
    await expect(
      missingSource.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(0);
    await expect(missingSource).not.toContainText("identical failures");
    await expect(page.locator("[data-source-reads]")).toHaveText("0");
  },
);
