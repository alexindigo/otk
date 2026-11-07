// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { reply, seed } from "../../pages/attention.ts";
import { badge, focusNotifications, toast } from "../../pages/notifications.ts";

test.use({ profile: "contract-attention-native" });
test(
  "attention.notification-focused-background-open-keeps-draft-selected-is-silent",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const a = await seed(state, "Open A"),
      b = await seed(state, "Background B");
    await page.context().grantPermissions(
      ["clipboard-read", "clipboard-write"],
      { origin: state.url },
    );
    const finish = async (text: string) => {
      await state.queue([text]);
      await state.product("session.prompt", {
        sessionID: b.id,
        mode: "normal",
        parts: [{ kind: "text", text: "Run notification completion" }],
      });
    };
    await focusNotifications(page);
    await openSession(state, page, a.id);
    await page.locator("textarea[name=prompt]").fill("Keep unsent draft");
    await finish("Background completed");
    const note = page.locator(toast(b.id));
    await expect(note).toContainText("Session done");
    await badge(page, 1);
    expect(
      await note.locator(".otk-surface").evaluate((surface) => {
        const r = surface.getBoundingClientRect(),
          s = getComputedStyle(surface);
        return Array.from(
          surface.querySelectorAll(".otk-toast-message,.otk-toast-actions"),
        ).every((e) => {
          const b = e.getBoundingClientRect();
          return b.left >= r.left + parseFloat(s.paddingLeft) - .5 &&
            b.right <= r.right - parseFloat(s.paddingRight) + .5 &&
            b.top >= r.top + parseFloat(s.paddingTop) - .5 &&
            b.bottom <= r.bottom - parseFloat(s.paddingBottom) + .5;
        });
      }),
    ).toBe(true);
    await note.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${b.id}$`));
    await badge(page, 0);
    await openSession(state, page, a.id);
    await expect(page.locator("textarea[name=prompt]")).toHaveValue(
      "Keep unsent draft",
    );
    await expect(note).toHaveCount(0);
    await openSession(state, page, b.id);
    await reply(page, b.id, "Background completed");
    await page.locator('[data-message-command="reply.copy"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Background completed");
    await finish("Selected completed");
    await reply(page, b.id, "Selected completed");
    await expect(page.locator(".otk-toast")).toHaveCount(0);
    await badge(page, 0);
  },
);
