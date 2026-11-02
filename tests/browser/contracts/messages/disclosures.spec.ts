// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
test.use({ profile: "contract-messages-disclosures" });
test("messages.disclosures-unmount-retain-choice-draft", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSession(state, page, "tstv1-otk");
  const toggle = page.locator(".otk-tool-toggle");
  await expect(toggle).toBeAttached();
  await expect(page.locator(".otk-tool-body .otk-code")).toHaveCount(0);
  await toggle.click();
  await expect(page.locator(".otk-code")).toContainText("foldedSecret");
  await toggle.click();
  await expect(page.locator(".otk-tool-body")).toHaveCount(0);
  await page.locator(".otk-work-fold").click();
  await expect(page.locator(".otk-work-body")).toHaveCount(0);
  await page.locator(".otk-work-fold").click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.locator("textarea[name=prompt]").fill("Keep the disclosure draft");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".otk-message,.otk-code")).toHaveCount(0);
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Keep the disclosure draft",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Keep the disclosure draft",
  );
});
