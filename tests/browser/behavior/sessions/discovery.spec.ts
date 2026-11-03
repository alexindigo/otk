// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "sessions-discovery" });
test("sessions.idle-discovered-catalog-zero-native-instance-wake", {
  tag: ["@sessions", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url);
  await expect(page.locator(".otk-discovered-projects .otk-project-row"))
    .toHaveCount(2);
  expect(
    await page.locator(".otk-discovered-projects .otk-status-light")
      .evaluateAll((es) => es.map((e) => e.getAttribute("data-state"))),
  ).toEqual(["idle", "idle"]);
  expect(
    (await state.observe<{ discovery: { creations: string[] } }>()).discovery
      .creations,
  ).toEqual([]);
});
