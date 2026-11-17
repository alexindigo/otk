// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-messages-failure-ownership" });
test("messages.mixed-failure-reply-retains-assistant-usage-and-actions", {
  tag: ["@messages", "@contracts", "@composer"],
}, async ({ isolatedState: state, page }, info) => {
  await openSession(state, page, "tstv1-core");
  const reply = page.locator('[data-message="assistant"]');
  await expect(reply).toContainText(
    "Assistant answer survives the context failure.",
  );
  await expect(reply).toContainText("Retained native failure");
  await expect(reply.locator(".otk-message-footer")).toContainText(
    "fixture/model",
  );
  await expect(reply.locator(".otk-turn-usage > button")).toBeVisible();
  await reply.hover();
  await expect(reply.locator('[data-message-command="reply.copy"]'))
    .toBeVisible();
  await expect(reply.locator('[data-message-command="reply.fork"]'))
    .toBeVisible();
  await info.attach("mixed-failure-reply", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});

for (const available of [true, false]) {
  test(
    `messages.retained-failure-reference-${
      available ? "acquires-and-focuses" : "reports-missing-source"
    }`,
    {
      tag: ["@messages", "@contracts", "@composer"],
    },
    async ({ isolatedState: state, page }) => {
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: available ? "hold" : "fail",
      });
      await openSession(state, page, "tstv1-core");
      const record = page.locator('[data-message="failure-old"]');
      await expect(page.locator('[data-message="history-49"]')).toBeVisible();
      await expect(record).toHaveCount(0);
      const editor = page.locator("textarea[name=prompt]");
      await editor.fill("Keep this draft when revealing the error");
      await editor.press("Enter");
      const link = page.locator(".otk-operation-feedback").getByRole("link", {
        name: "See the retained failure",
      });
      await expect(link).toBeVisible();
      const before =
        (await state.observe<{ pages: (string | null)[] }>()).pages.length;
      await link.click();
      if (available) {
        await expect(record).toContainText("Retained native failure");
        await expect(record).toBeFocused();
      } else {
        await expect(page.locator(".otk-messages")).toContainText(
          "This message is no longer available",
        );
        await expect(record).toHaveCount(0);
      }
      await expect.poll(async () =>
        (await state.observe<{ pages: (string | null)[] }>()).pages.length
      ).toBeGreaterThan(before);
      await expect(editor).toHaveValue(
        "Keep this draft when revealing the error",
      );
      await expect(page.locator(".otk-session-error")).toHaveCount(0);
    },
  );
}
