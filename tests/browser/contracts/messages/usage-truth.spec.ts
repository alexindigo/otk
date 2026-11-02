// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.describe("unreported live usage", () => {
  test.use({ profile: "contract-messages-usage-unreported" });
  test("messages.unreported-versus-zero-live-usage", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/#/local/tstv1-core");
    const trigger = page.locator(".otk-turn-usage > button");
    await expect(trigger).toContainText("Cost unavailable");
    await trigger.hover();
    const row = page.locator(".otk-usage-breakdown tbody tr");
    await expect(row.locator(":scope > *").nth(3)).toHaveText("Not reported");
    await expect(row.locator(":scope > *").nth(8)).toHaveText("Not reported");
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "succeed",
    });
    await expect(row.locator(":scope > *").nth(3)).toHaveText("0");
    await expect(row.locator(":scope > *").nth(8)).toHaveText("$0.00");
  });
});
test.describe("unknown prices", () => {
  test.use({ profile: "contract-messages-usage-unknown" });
  test("messages.unknown-prices-five-categories", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/#/local/tstv1-core");
    const trigger = page.locator(".otk-turn-usage > button");
    await expect(trigger).toHaveText("1 model call · 240 tokens · $0.43");
    await trigger.hover();
    await expect(page.locator(".otk-usage-breakdown tbody tr")).toHaveText(
      "1answered19010020304050$0.430.0s",
    );
    expect(
      await trigger.evaluate((t) => {
        const panel = document.getElementById(
          t.getAttribute("popovertarget")!,
        )!;
        return {
          nativeTooltip: !!t.closest("[title]"),
          label: t.getAttribute("aria-label"),
          description:
            document.getElementById(t.getAttribute("aria-describedby")!) ===
              panel,
          open: panel.matches(":popover-open"),
        };
      }),
    ).toEqual({
      nativeTooltip: false,
      label: "Turn usage: 1 model call · 240 tokens · $0.43; exact cost $0.43",
      description: true,
      open: true,
    });
  });
});
test.describe("queued provider identity", () => {
  test.use({ profile: "contract-messages-usage-queued" });
  test("messages.queued-turn-per-provider-category-costs", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/#/local/tstv1-core");
    const trigger = page.locator(".otk-turn-usage > button");
    await expect(trigger).toHaveText("2 model calls · 480K tokens · $0.86");
    await expect(trigger).toHaveCount(1);
    await trigger.hover();
    await expect.poll(() =>
      page.locator(".otk-usage-breakdown tfoot tr").locator(":scope > *")
        .allTextContents()
    ).toEqual([
      "Total",
      "380,000",
      "200,000$0.60",
      "40,000$0.24",
      "60,000$0.36",
      "80,000$0.06",
      "100,000$0.45",
      "$0.86",
      "0.0s",
    ]);
  });
});
