// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-messages-public-ui" });
test("attention.public-own-answer-resizes-after-collapse-remount-and-shrinks", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(`${state.url}/?shared-controls`);
  await page.locator("[data-dark]").click();
  const answer = page.locator("textarea[name=question-answer]");
  const text = Array.from(
    { length: 6 },
    (_, n) => `Restored answer line ${n + 1}`,
  ).join("\n");
  await answer.fill(text);
  await page.getByRole("button", { name: "Hide the question", exact: true })
    .click();
  await page.getByRole("button", { name: "Show the question", exact: true })
    .click();
  await page.locator("[data-remount]").click();
  await expect(answer).toHaveCount(0);
  await page.locator("[data-remount]").click();
  await expect(answer).toHaveValue(text);
  await expect.poll(() =>
    answer.evaluate((e) => e.clientHeight >= e.scrollHeight - 1)
  ).toBe(true);
  await answer.fill("Short answer");
  await expect.poll(() => answer.evaluate((e) => e.clientHeight))
    .toBeLessThanOrEqual(24);
});
