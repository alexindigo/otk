// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-visual-styles" });
test("attention.toasts.page-survives-dismiss", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url + "/?scene=failures");
  await page.getByRole("button", { name: "Repeat failure", exact: true })
    .click();
  await page.getByRole("button", { name: "Mixed notifications", exact: true })
    .click();
  const count = page.locator("[data-note-count]");
  await expect(count).toHaveAttribute("data-note-count", "7");

  const stack = page.getByRole("region", { name: "Notifications" });
  const more = stack.locator(".otk-toasts-more");
  const cards = stack.locator(".otk-toast");
  const reasons = cards.locator(".otk-failure-main-reason .otk-failure-reason");
  await more.click();
  await expect(reasons).toHaveText([
    "Distinct failure 3",
    "Distinct failure 2",
    "Distinct failure 1",
  ]);
  await expect(more).toHaveText("23 more failures, 2 more need you");
  const widths = await cards.evaluateAll((rows) =>
    rows.map((row) => row.getBoundingClientRect().width)
  );
  await expect(more).toBeInViewport({ ratio: 1 });
  // A long translation or a large count should not become the sizing row.
  const withLongLabel = await more.locator(".otk-control-label").evaluate(
    (element) => {
      const text = element.firstChild as Text;
      const label = text.data;
      try {
        text.data = `${label} `.repeat(10).trimEnd();
        return Array.from(element.closest(".otk-toasts")!.querySelectorAll(
          ".otk-toast",
        )).map((row) => row.getBoundingClientRect().width);
      } finally {
        text.data = label;
      }
    },
  );
  expect(withLongLabel).toEqual(widths);

  await cards.filter({ hasText: "Distinct failure 2" }).getByRole("button", {
    name: "Dismiss notification",
    exact: true,
  }).click();
  await expect(count).toHaveAttribute("data-note-count", "6");
  await expect(reasons).toHaveText([
    "Distinct failure 3",
    "Distinct failure 1",
    "The native session was not found",
  ]);
  await expect(more).toHaveText("1 more failure, 2 more need you");
});
