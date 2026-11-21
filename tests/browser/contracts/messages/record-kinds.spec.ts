// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-messages-disclosures" });
test(
  "messages.bookkeeping-kind-defaults-also-govern-expanded-background-intervals",
  {
    tag: ["@messages", "@contracts"],
  },
  async ({ isolatedState: state, page }) => {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "thaw",
    });
    await openSession(state, page, "tstv1-otk");
    const interval = page.locator("[data-background-interval]");
    await expect(interval).toHaveCount(1);
    await interval.locator(".otk-record-group-toggle").first().click();
    await expect(interval.locator(".otk-native-record")).toHaveCount(0);
    await interval.locator('[data-record-kind="stepMarkers"]').click();
    await expect(interval.locator('[data-native-record^="opencode-v1/step-"]'))
      .toHaveCount(2);
    await expect(
      interval.locator('[data-native-record="opencode-v1/snapshot"]'),
    ).toHaveCount(0);
    await interval.locator('[data-record-kind="snapshots"]').click();
    await expect(interval.locator(".otk-native-record")).toHaveCount(3);
  },
);

test(
  "messages.bookkeeping-folds-into-work-header-without-losing-native-records",
  {
    tag: ["@messages", "@contracts", "@scroll"],
  },
  async ({ isolatedState: state, page }, info) => {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
    });
    await state.product("prefs.set", { key: "expandWork", value: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSession(state, page, "tstv1-otk");
    const work = page.locator(".otk-work-log");
    const steps = work.locator('[data-native-record^="opencode-v1/step-"]');
    const snapshots = work.locator(
      '[data-native-record="opencode-v1/snapshot"]',
    );
    const count = work.locator('[data-record-kind="stepMarkers"]');
    await expect(count).toHaveText("4 step markers");
    await expect(count).toHaveAttribute("aria-expanded", "false");
    await expect(steps).toHaveCount(0);
    await expect(snapshots).toHaveCount(0);
    await expect(work.locator("[data-tool=write]")).toHaveCount(2);
    const heights: Record<string, number[]> = {};
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
        "otk-light-stone",
        "stone",
      ]]
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.evaluate(() => document.fonts.ready);
      const closed = await work.evaluate((element) =>
        element.getBoundingClientRect().height
      );
      await page.screenshot({
        path: info.outputPath(`worklog-steps-collapsed-${name}.png`),
        fullPage: true,
      });
      await count.click();
      await expect(steps).toHaveCount(4);
      await expect(steps).toHaveText([
        /Step started/,
        /Step finished/,
        /Step started/,
        /Step finished/,
      ]);
      const expanded = await work.evaluate((element) =>
        element.getBoundingClientRect().height
      );
      expect(expanded - closed).toBeGreaterThan(80);
      heights[name] = [closed, expanded];
      await page.screenshot({
        path: info.outputPath(`worklog-steps-expanded-${name}.png`),
        fullPage: true,
      });
      const first = steps.first().getByRole("button", {
        name: "Step started",
        exact: true,
      });
      await first.click();
      await expect(steps.first().locator(".otk-native-parameters"))
        .toContainText("stop");
      await first.click();
      await count.click();
      await expect(steps).toHaveCount(0);
    }
    await work.locator('[data-record-kind="snapshots"]').click();
    await expect(snapshots).toHaveCount(1);
    // Explicit choices survive preference changes; a fresh page borrows saved defaults.
    await state.product("prefs.set", { key: "expandStepMarkers", value: true });
    await expect(steps).toHaveCount(0);
    await page.reload();
    await expect(steps).toHaveCount(4);
    await expect(snapshots).toHaveCount(0);
    await state.product("prefs.set", {
      key: "expandStepMarkers",
      value: false,
    });
    await expect(steps).toHaveCount(0);
    await info.attach("worklog-geometry", {
      body: JSON.stringify(heights),
      contentType: "application/json",
    });
  },
);
