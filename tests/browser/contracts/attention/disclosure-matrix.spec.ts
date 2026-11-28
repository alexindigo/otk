// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { labelDisclosure } from "../disclosure-contract.ts";

test.use({ profile: "contract-visual-styles" });
const tag = { tag: ["@attention", "@contracts"] };

test("attention.disclosure.toast-details", tag, async ({
  page,
  isolatedState: state,
}) => {
  const repeat = page.getByRole("button", { name: "Repeat failure" });
  const mixed = page.getByRole("button", { name: "Mixed notifications" });
  const toast = page.locator(".otk-toast").filter({
    hasText: "The native session was not found",
  });
  const trigger = toast.getByRole("button", { name: "Details", exact: true });
  await page.goto(`${state.url}/?scene=failures`);
  await repeat.click();
  const region = await labelDisclosure(trigger);
  await trigger.press("ArrowRight");
  await expect(region).toContainText("Diagnostic ID");
  await mixed.click();
  const more = page.locator(".otk-toasts-more");
  // The navigation covers mixed pages; find the occurrence, not a slot.
  for (let n = 0; n < 6 && await toast.count() === 0; n++) await more.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await more.click();
  await expect(toast).toHaveCount(0);
  for (let n = 0; n < 6 && await toast.count() === 0; n++) await more.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await toast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toast).toHaveCount(0);
  await repeat.click();
  for (let n = 0; n < 6 && await toast.count() === 0; n++) await more.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.press("ArrowRight");
  await page.reload();
  await repeat.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("attention.disclosure.inline-details", tag, async ({
  page,
  isolatedState: state,
}) => {
  await page.goto(`${state.url}/?scene=error-surfaces`);
  const trigger = page.locator(
    ".error-review-panel > .otk-feedback-status:not(.otk-field-feedback)",
  )
    .getByRole("button", { name: "Details", exact: true });
  await labelDisclosure(trigger);
  await trigger.press("ArrowRight");
  await page.reload();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});
