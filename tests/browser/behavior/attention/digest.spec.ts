// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { scenario } from "../../pages/attention.ts";
import { badge, focusNotifications, toast } from "../../pages/notifications.ts";

test.use({ profile: "contract-attention-digest" });
test(
  "attention.consumed-digest-keeps-real-notification-action-tombstone-retracts",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    await focusNotifications(page);
    const row = page.locator('[data-session="tstv1-note"]'),
      note = page.locator(toast("tstv1-note"));
    const finish = async () => {
      await scenario(state, "hold", "tstv1-note");
      await expect(row).toHaveAttribute("data-status", "busy");
      await scenario(state, "release", "tstv1-note");
      await expect(note.getByRole("button", { name: "Open", exact: true }))
        .toBeVisible();
      await badge(page, 1);
    };
    await finish();
    await scenario(state, "succeed");
    await expect(row.locator(".otk-session-cost")).toHaveText("$0.75");
    await badge(page, 1);
    await note.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/tstv1-note$/);
    await expect(note).toHaveCount(0);
    await badge(page, 0);
    await openSession(state, page, "tstv1-otk");
    await finish();
    await scenario(state, "fail");
    await expect(row).toHaveClass(/is-deleted/);
    await expect(note).toHaveCount(0);
    await badge(page, 0);
  },
);
