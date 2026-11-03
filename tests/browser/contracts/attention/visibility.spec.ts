// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { notificationTest as test } from "../../fixtures/notifications.ts";
import {
  focusNotifications,
  hideNotifications,
} from "../../pages/notifications.ts";

test("attention.notification-profile-observes-real-hidden-visibilitychange", {
  tag: ["@attention", "@fixture-acceptance"],
}, async ({ page }) => {
  await page.goto(
    "data:text/html,<title>Native visibility acceptance</title><button>Native focus</button>",
  );
  await focusNotifications(page);
  await page.evaluate(
    "globalThis.visibilityEvents=[];document.addEventListener('visibilitychange',()=>visibilityEvents.push(document.visibilityState))",
  );
  const restore = await hideNotifications(page);
  expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
  expect(await page.evaluate("visibilityEvents")).toContain("hidden");
  await restore();
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe(
    "visible",
  );
  expect(await page.evaluate("visibilityEvents")).toContain("visible");
});
