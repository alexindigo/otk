// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import { menuGeometry } from "./overlays.ts";
export async function nativeStates({
  state,
  page,
  themes,
  native,
  paint,
  shot,
}: {
  state: TestState;
  page: Page;
  themes: { id: string }[];
  native: { url: string; automaticID: string; emptyID: string };
  paint(theme: { id: string }): Promise<void>;
  shot(name: string): Promise<void>;
}) {
  await test.step("9/native-automatic-and-activity-states", async () => {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      sessionID: "tstv1-native-auto",
      action: "hold",
    });
    await page.goto(native.url + "/#/local/" + native.automaticID);
    await expect.poll(async () =>
      (await state.observe<{ native: { automaticReplying: boolean } }>()).native
        .automaticReplying
    ).toBe(true);
    await expect(page.locator(".otk-auto-approving")).toHaveText(
      "Auto-approving\u2026",
    );
    for (const theme of themes) {
      await paint(theme);
      await expect(
        page.locator(
          ".otk-permission-dock,.otk-status-light[data-state=blocked]",
        ),
      ).toHaveCount(0);
      await expect(page.locator(".otk-composer")).toBeVisible();
      const toggle = page.locator(".otk-auto-approve-toggle");
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(
        await toggle.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return [
            r.width,
            r.height,
            el.getAttribute("aria-label"),
            !!el.querySelector("svg"),
          ];
        }),
      ).toEqual([28, 28, "Auto-approve", true]);
      const mark = page.locator(
        `[data-session="${native.automaticID}"] .otk-auto-mark`,
      );
      await expect(mark).toHaveCount(0);
      await shot(`native-auto-pending-${theme.id}`);
    }
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      sessionID: "tstv1-native-auto",
      action: "release",
    });
    await expect(page.locator('[data-role="assistant"] .otk-text'))
      .toContainText(
        "Quiet automatic reply completed",
      );
    await page.locator('[data-panel-view="activity"]').click();
    await expect(page.locator(".otk-permission-activity")).toContainText(
      "quiet-auto.txt",
    );
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      sessionID: "tstv1-native-auto",
      action: "fail",
    });
    await page.reload();
    for (const theme of themes) {
      await paint(theme);
      await expect(page.locator(".otk-permission-activity")).toContainText(
        "Reply started; outcome not confirmed",
      );
      await expect(page.locator(".otk-permission-activity")).not.toContainText(
        "Stored failure fixture",
      );
      await expect(
        page.locator(
          ".otk-permission-activity [role=status]:not([aria-hidden=true])",
        ),
      ).toHaveCount(0);
      await shot(`native-auto-activity-${theme.id}`);
    }
    // Sidebar measurements own the Sessions projection, never the Activity
    // projection deliberately left by the persisted activity scenes above.
    await page.locator('[data-panel-view="sessions"]').click();
    await expect(page.locator(`[data-session="${native.automaticID}"]`))
      .toBeVisible();
    for (const enabled of [false, true]) {
      await page.locator(".otk-auto-approve-toggle").click();
      await expect(page.locator(".otk-auto-approve-toggle")).toHaveAttribute(
        "aria-pressed",
        String(enabled),
      );
      for (const theme of themes) {
        await paint(theme);
        await page.locator(`[data-session="${native.automaticID}"]`).click({
          button: "right",
        });
        await menuGeometry(page);
        await shot(`native-auto-menu-${enabled}-${theme.id}`);
        await page.keyboard.press("Escape");
      }
    }
    await page.locator("[data-role=assistant] .otk-text").first().click({
      button: "right",
    });
    await page.locator(':popover-open [data-context-command="reply.usage"]')
      .click();
    for (const theme of themes) {
      await paint(theme);
      await expect(page.locator(".otk-usage-breakdown tbody tr").first())
        .toBeVisible();
      await shot(`native-reply-usage-${theme.id}`);
    }
    await page.keyboard.press("Escape");
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      sessionID: "tstv1-native-interrupt",
      action: "hold",
    });
    await page.goto(native.url + "/#/local/" + native.emptyID);
    await expect(page.locator("[data-role=assistant] .otk-text")).toContainText(
      "continuing",
    );
    await page.keyboard.press("Escape");
    for (const theme of themes) {
      await paint(theme);
      await expect(page.locator("[data-interrupt-confirmation][role=status]"))
        .toHaveText("Esc again to interrupt");
      await shot(`native-interrupt-confirmation-${theme.id}`);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator(".otk-message-footer")).toContainText(
      "interrupted",
    );
    for (const theme of themes) {
      await paint(theme);
      // An interruption is terminal evidence acknowledged by this open view.
      const marker = page.locator(
        `[data-session="${native.emptyID}"] .otk-status-light[data-state=none]`,
      );
      await expect(marker).toBeVisible();
      expect(
        await marker.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return [
            r.width,
            Math.abs(r.width - r.height),
            getComputedStyle(el.querySelector(".otk-lamp-body")!).borderRadius,
          ];
        }),
      ).toEqual([8, 0, "50%"]);
      await shot(`native-interrupted-marker-${theme.id}`);
    }
  });
}
