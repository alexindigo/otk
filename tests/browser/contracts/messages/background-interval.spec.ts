// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import type { Commands } from "../../../support/fixture-control.ts";

const action = (state: TestState, action: Commands["scenario"]["action"]) =>
  state.controller.call("scenario", {
    lease: state.lease.lease,
    target: "backgrounds",
    action,
  });
test.use({ profile: "contract-messages-running-layout" });

test("messages.background-interval-owns-one-frame-and-compact-chronology", {
  tag: ["@messages", "@sessions", "@contracts", "@scroll"],
}, async ({ isolatedState: state, page }, info) => {
  const { session } = await state.observe<{ session: string }>();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSession(state, page, session);
  await action(state, "freeze");
  const interval = page.locator("[data-background-interval]");
  await expect(interval).toHaveCount(1);
  await expect(page.locator('[data-message="background-1"]')).toBeVisible();
  const original = await interval.elementHandle();
  await action(state, "release");
  await expect(interval.locator(".otk-record-group-toggle > .otk-chrome-meta"))
    .toHaveText(
      "1 permission",
    );
  await action(state, "freeze");
  await action(state, "release");
  await action(state, "succeed");
  await action(state, "hold");
  await action(state, "thaw");
  await action(state, "succeed");
  await action(state, "hold");
  await action(state, "thaw");
  await action(state, "succeed");
  await expect(interval).toHaveCount(1);
  await expect(interval).toHaveAttribute("data-count", "7");
  expect(
    await interval.evaluate(
      (element, original) => element === original,
      original,
    ),
  ).toBe(true);
  const summary = interval.locator(
    ".otk-record-group-toggle > .otk-chrome-meta",
  ).first();
  await expect(summary).toHaveText("2 permissions, 2 helpers finished");
  await expect(interval.locator(".otk-record-group-time")).toHaveCount(0);
  const root = page.locator(
    '.otk-virtual-list[aria-label="Transcript messages"]',
  );
  await expect(root).toHaveAttribute("data-acquired-count", "3");
  for (
    const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await page.evaluate(() => document.fonts.ready);
    await expect(interval.locator(".otk-record-group-toggle").first())
      .toHaveAttribute("aria-expanded", "false");
    const facts = await summary.evaluate((element) => {
      const style = getComputedStyle(element),
        root = element.closest("[data-background-interval]")!;
      const box = root.getBoundingClientRect();
      return {
        color: style.color,
        weight: style.fontWeight,
        size: style.fontSize,
        meta: getComputedStyle(root).getPropertyValue("--text-meta").trim(),
        height: box.height,
      };
    });
    expect(facts.weight).toBe("400");
    expect(facts.height).toBeLessThan(40);
    await page.screenshot({
      path: info.outputPath(`wp16-folded-${name}.png`),
      fullPage: true,
    });
    await interval.locator(".otk-record-group-toggle").first().click();
    await expect(interval.locator(".otk-message[data-role=context]"))
      .toHaveCount(7);
    await expect(
      interval.getByRole("button", {
        name: "Open Open task session",
        exact: true,
      }),
    ).toHaveCount(2);
    const records = await interval.locator(".otk-message[data-role=context]")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          id: element.getAttribute("data-message"),
          margin: getComputedStyle(element).marginBottom,
          top: element.getBoundingClientRect().top,
          bottom: element.getBoundingClientRect().bottom,
        }))
      );
    expect(records.map((record) => record.id)).toEqual(
      Array.from({ length: 7 }, (_, n) => `background-${n + 1}`),
    );
    for (let n = 0; n < records.length; n++) {
      expect(records[n].margin).toBe("0px");
      if (n) {
        expect(records[n].top - records[n - 1].bottom).toBeLessThanOrEqual(1);
      }
    }
    await page.screenshot({
      path: info.outputPath(`wp16-expanded-${name}.png`),
      fullPage: true,
    });
    await interval.locator(".otk-record-group-toggle").first().click();
  }
  await action(state, "fail");
  await page.locator(".otk-composer-notice").getByRole("button", {
    name: "See response",
  }).click();
  await expect(page.locator('[data-message="background-7"]')).toBeFocused();
  const record = page.locator('[data-message="background-7"]');
  await record.locator(".otk-tool-toggle").click();
  await expect(record.locator("[data-record-time]")).toHaveAttribute(
    "datetime",
    new Date(107).toISOString(),
  );
  await expect(record.locator("[data-record-time]")).toContainText(".107");
});

test("messages.success-only-interval-borrows-footer-and-direct-reveal", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  const { session } = await state.observe<{ session: string }>();
  await state.product("prefs.set", { key: "expandRecords", value: true });
  await openSession(state, page, session);
  await action(state, "succeed");
  await expect(page.locator("[data-background-interval]")).toHaveCount(0);
  const footer = page.locator(
    ".otk-message-footer .otk-record-completion .otk-tree-toggle",
  );
  await expect(footer).toBeVisible();
  await footer.click();
  await expect(page.locator('[data-message="background-1"]')).toBeVisible();
  await footer.click();
  await expect(page.locator("[data-background-interval]")).toHaveCount(0);
  await action(state, "fail");
  await page.locator(".otk-composer-notice").getByRole("button", {
    name: "See response",
  }).click();
  await expect(page.locator('[data-message="background-1"]')).toBeFocused();
});

test("messages.pending-breakout-reveal-and-settlement-retain-the-frame", {
  tag: ["@messages", "@contracts", "@attention"],
}, async ({ isolatedState: state, page }) => {
  const { session } = await state.observe<{ session: string }>();
  await openSession(state, page, session);
  await action(state, "freeze");
  const interval = page.locator("[data-background-interval]");
  const key = await interval.getAttribute("data-background-interval");
  await action(state, "fail");
  await page.locator(".otk-composer-notice").getByRole("button", {
    name: "See response",
  }).click();
  await expect(page.locator('[data-message="background-1"]')).toBeFocused();
  await action(state, "release");
  await expect(interval).toHaveAttribute("data-background-interval", key!);
  await expect(interval.locator(".otk-record-group-toggle > .otk-chrome-meta"))
    .toHaveText(
      "1 permission",
    );
});

test("messages.failure-separates-safe-stretches-inside-one-background-frame", {
  tag: ["@messages", "@contracts", "@attention"],
}, async ({ isolatedState: state, page }) => {
  const { session } = await state.observe<{ session: string }>();
  await openSession(state, page, session);
  await action(state, "freeze");
  await action(state, "release");
  await action(state, "succeed");
  await action(state, "disconnect");
  await action(state, "freeze");
  await action(state, "release");
  // release settles all records, so restore the failed outcome before appending.
  await action(state, "disconnect");
  await action(state, "succeed");
  const interval = page.locator("[data-background-interval]");
  await expect(interval).toHaveCount(1);
  await expect(interval.locator(".otk-native-record.is-error")).toHaveCount(1);
  // Issue 2.42 keeps one chronological frame rather than partitioning stretches;
  // UI conventions omit footer completions and count the failed breakout once.
  await expect(interval.locator(".otk-record-group-toggle > .otk-chrome-meta"))
    .toHaveText("1 permission · 1 failed");
  const key = await interval.getAttribute("data-background-interval");
  await action(state, "stop");
  await expect(interval).toHaveAttribute("data-background-interval", key!);
  await expect(interval.locator(".otk-native-record.is-error")).toHaveCount(0);
  await expect(interval.locator(".otk-record-group-toggle > .otk-chrome-meta"))
    .toHaveText(
      "2 permissions",
    );
});
