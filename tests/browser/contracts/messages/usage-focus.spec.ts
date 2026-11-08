// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";

test.use({ profile: "contract-messages-usage3" });
test("messages.usage-preview-retains-loading-region-focus", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  const frames = await wire(page);
  frames.hold((_frame, request) => request?.method === "usage.get");
  await page.goto(`${state.url}/#/local/tstv1-core`);
  const trigger = page.locator(".otk-turn-usage > button"),
    panel = page.locator(".otk-turn-usage :popover-open"),
    region = page.getByRole("region", { name: "Model calls", exact: true });
  await expect(trigger).toHaveText(/^3 model calls/);
  await page.locator("textarea[name=prompt]").click();
  await trigger.focus();
  await expect(panel).toBeVisible();
  await expect.poll(() => frames.held.length).toBeGreaterThan(0);
  await expect(panel).toContainText("Loading usage breakdown");
  await expect(region).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(region).toBeFocused();
  const original = await region.elementHandle();
  frames.release();
  await expect(page.locator(".otk-usage-breakdown tbody tr")).toHaveCount(3);
  await expect(region).toBeFocused();
  expect(
    await original!.evaluate((element) =>
      element.isConnected && element === document.activeElement
    ),
  ).toBe(true);
  await info.attach("usage-focus", {
    body: JSON.stringify(
      await region.evaluate((element) => ({
        active: element === document.activeElement,
        label: element.getAttribute("aria-label"),
        rows: element.querySelectorAll("tbody tr").length,
      })),
    ),
    contentType: "application/json",
  });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-message-command="reply.copy"]'))
    .toBeFocused();
});
