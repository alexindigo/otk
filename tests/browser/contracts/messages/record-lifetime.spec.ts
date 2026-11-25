// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-visual-styles" });
test("messages.record-content-retains-its-keyed-lifetime-when-facts-change", {
  tag: ["@messages", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(`${state.url}/?scene=record-lifetime`);
  const record = page.locator("[data-record-lifetime=retained]");
  await expect(record).toHaveText("Record revision 0");
  const original = await record.elementHandle();
  await record.focus();
  // Drive the owner update without moving the reader's focus to the button.
  await page.getByRole("button", { name: "Update record facts", exact: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(record).toHaveText("Record revision 1");
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
  expect(
    await record.evaluate(
      (element, original) => element === original,
      original,
    ),
  )
    .toBe(true);
  await expect(record).toBeFocused();
  await original!.dispose();
});
