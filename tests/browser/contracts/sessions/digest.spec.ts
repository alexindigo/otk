// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";

test.describe("digest lifetime", () => {
  test.use({ profile: "contract-sessions-resurrection" });
  test(
    "sessions.tombstone-releases-content-resurrection-reacquires-once-with-draft",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      const frames = await wire(page);
      await page.goto(`${state.url}/#/local/tstv1-core`);
      await expect(page.locator(".otk-messages")).toContainText(
        "Core transcript",
      );
      await page.locator("textarea[name=prompt]").fill(
        "A retained unsent draft",
      );
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "hold",
      });
      await expect(page.locator(".otk-deleted-session")).toBeVisible();
      await expect(page.locator(".otk-prompt")).toHaveCount(0);
      const count =
        frames.sent.filter(({ frame }) => frame.method === "session.messages")
          .length;
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "release",
      });
      await expect(page.locator(".otk-messages")).toContainText(
        "Core transcript",
      );
      await expect(page.locator("textarea[name=prompt]")).toHaveValue(
        "A retained unsent draft",
      );
      expect(
        frames.sent.filter(({ frame }) => frame.method === "session.messages"),
      ).toHaveLength(count + 1);
      await expect(page).toHaveURL(/#\/local\/tstv1-core$/);
    },
  );
});
test.describe("unknown summary", () => {
  test.use({ profile: "contract-sessions-unknown" });
  test("sessions.unknown-summary-rejected-detail-has-no-invented-zero", {
    tag: ["@sessions", "@contracts", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/#/local/tstv1-core`);
    const trigger = page.locator(".otk-turn-usage-trigger");
    await expect(trigger).toContainText("Tokens unavailable");
    await expect(trigger).toContainText("Cost unavailable");
    await trigger.hover();
    await expect(page.locator(".otk-turn-usage :popover-open [role=status]"))
      .toHaveText("Could not finish this action. Try again");
    await expect(page.locator(".otk-usage-breakdown")).toHaveCount(0);
    await expect(page.locator(".otk-message-footer")).not.toContainText(
      "$0.00",
    );
  });
});
test.describe("summary-only backend", () => {
  test.use({ profile: "contract-sessions-summary" });
  test("sessions.summary-only-facts-no-dead-usage-action", {
    tag: ["@sessions", "@contracts", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await expect(page.locator(".otk-message-footer")).toContainText(
      "1 model call",
    );
    await expect(page.locator(".otk-turn-usage-trigger")).toHaveCount(0);
    await page.locator("[data-role=assistant]").click({ button: "right" });
    await expect(
      page.locator(':popover-open [role="menu"][aria-label="Context menu"]'),
    ).toBeVisible();
    await expect(
      page.locator(':popover-open [data-context-command="reply.usage"]'),
    ).toHaveCount(0);
  });
});
