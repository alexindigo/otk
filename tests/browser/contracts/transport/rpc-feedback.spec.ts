// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";

test.use({ profile: "contract-rpc" });
test("transport.rpc-feedback-ownership", {
  tag: ["@transport", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  let corrupt = false;
  const frames = await wire(page, (frame) => {
    if (!corrupt || frame.t !== "request") return frame;
    if (frame.method === "layout.patch") {
      return { ...frame, params: { leftWidth: "invalid" } };
    }
    if (frame.method === "prefs.set") {
      return {
        ...frame,
        params: { key: frame.params!.key, value: { invalid: true } },
      };
    }
    return frame;
  });
  await page.goto(`${state.url}/#/local/tstv1-otk`);
  await expect(
    page.getByRole("button", { name: "Collapse projects", exact: true }),
  ).toBeVisible();
  corrupt = true;
  await page.getByRole("button", { name: "Collapse projects", exact: true })
    .click();
  const failures = page.locator(".otk-toast .otk-failure-content");
  await expect(failures).toHaveCount(1);
  await page.getByRole("button", { name: "Display options", exact: true })
    .click();
  // D21 removed the clock toggle; rejected preference writes still belong here.
  await expect(page.locator('.otk-display-menu input[name="timestamps"]'))
    .toHaveCount(0);
  await page.locator('.otk-display-menu input[name="thinking"]').click();
  await expect(page.locator(".otk-display-menu [role=alert]")).toBeVisible();
  await expect(failures).toHaveCount(1);
  frames.fault({
    t: "error",
    code: "fixture",
    message: "Unsolicited protocol failure",
  });
  await expect(failures).toHaveCount(2);
  await expect(
    failures.filter({
      hasText: "Unsolicited protocol failure",
    }),
  ).toBeVisible();
});
