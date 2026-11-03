// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";

test.use({ profile: "contract-attention-demand" });
test(
  "attention.hidden-activity-releases-one-hundred-invalidations-and-reconnect",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const frames = await wire(page);
    const reads = () =>
      frames.sent.filter(({ frame }) => frame.method === "permission.activity")
        .length;
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await expect(page.locator(".otk-permission-dock")).toBeVisible();
    // Select and join authoritative layout state before observing the empty journal.
    await state.product("layout.patch", {
      rightCollapsed: false,
      rightView: "activity",
    });
    const activity = page.locator(".otk-permission-activity");
    await expect(activity).toContainText(
      "Permission replies will appear here.",
    );
    expect(reads()).toBe(1);
    await page.getByRole("button", {
      name: "Collapse right panel",
      exact: true,
    }).click();
    await expect(activity).toHaveCount(0);
    for (let n = 0; n < 100; n++) {
      await state.product("permission.reply", {
        sessionID: "tstv1-core",
        requestID: `ask-${n}`,
        reply: "once",
      });
    }
    expect((await state.observe<{ pending: number }>()).pending).toBe(0);
    frames.close();
    await expect.poll(() => frames.connections().opened).toBe(2);
    await expect(page.locator(".otk-connection-light").first()).toHaveAttribute(
      "data-connection-state",
      "connected",
    );
    await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
    expect(reads()).toBe(1);
    await page.getByRole("button", { name: "Open right panel", exact: true })
      .click();
    await expect(activity.locator("[data-activity]")).toHaveCount(100);
    await expect(activity.locator("[role=status]:not([aria-hidden=true])"))
      .toHaveCount(0);
    expect(reads()).toBe(2);
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "succeed",
    });
    const titles = activity.locator(".otk-activity-entry > p:first-of-type");
    await expect(titles).toHaveCount(100);
    await expect(titles).toHaveText(Array(100).fill("Current Activity title"));
    expect(reads()).toBe(2);
  },
);
