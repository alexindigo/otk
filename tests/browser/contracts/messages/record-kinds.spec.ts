// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { openLatestWork, recordToggle } from "../../pages/transcript.ts";

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
  async ({ isolatedState: state, page }) => {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSession(state, page, "tstv1-otk");
    const work = await openLatestWork(page);
    const steps = work.locator('[data-native-record^="opencode-v1/step-"]');
    const snapshots = work.locator(
      '[data-native-record="opencode-v1/snapshot"]',
    );
    const count = work.locator('[data-record-kind="stepMarkers"]');
    await expect(count).toHaveText("4 step markers");
    await expect(count.and(work.getByRole("button"))).toHaveCount(1);
    await expect(snapshots).toHaveCount(0);
    await count.click();
    await expect(steps).toHaveCount(4);
    await count.click();
    await expect(steps).toHaveCount(0);
    await expect(work.locator("[data-tool=write]")).toHaveCount(2);
    await work.locator('[data-record-kind="snapshots"]').click();
    await expect(snapshots).toHaveCount(1);
    const record = recordToggle(snapshots);
    await expect(record).toHaveAttribute("aria-expanded", "false");
    await state.product("prefs.set", { key: "expandRecords", value: true });
    await expect(record).toHaveAttribute("aria-expanded", "true");
    await record.click();
    for (const value of [false, true]) {
      await state.product("prefs.set", { key: "expandRecords", value });
      await expect(record).toHaveAttribute("aria-expanded", "false");
    }
    // Bookkeeping remains independently inspectable in the Work log panel.
    await state.product("prefs.set", { key: "expandStepMarkers", value: true });
    // The explicit close stays authoritative until the tab's choices retire.
    await expect(steps).toHaveCount(0);
    await page.reload();
    await openLatestWork(page);
    await expect(count).toHaveText("4 step markers");
    await expect(steps).toHaveCount(4);
    await expect(snapshots).toHaveCount(0);
  },
);
