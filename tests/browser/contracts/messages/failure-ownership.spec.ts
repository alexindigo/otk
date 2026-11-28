// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { scrollTranscript } from "../../pages/transcript.ts";

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
      const notice = page.locator(".otk-composer-notice");
      const link = notice.getByRole("button", {
        name: "Show error",
      });
      // Decision 65 / F7: a reference cannot acquire a record that is not yet
      // in this transcript projection. Page older history independently.
      await expect(notice).toContainText("Retained native failure");
      await expect(link).toHaveCount(0);
      // Issue 2.114: Details belongs to the notice, not the headline. The
      // retained record gets sole custody once the reference can be shown.
      const details = notice.getByRole("button", {
        name: "Details",
        exact: true,
      });
      await expect(details).toBeEnabled();
      const before =
        (await state.observe<{ pages: (string | null)[] }>()).pages.length;
      await scrollTranscript(page, false);
      await expect.poll(async () =>
        (await state.observe<{ pages: (string | null)[] }>()).pages.length
      ).toBeGreaterThan(before);
      if (available) {
        await expect(record).toContainText("Retained native failure");
        await expect(link).toBeVisible();
        await expect(details).toHaveCount(0);
        await link.click();
        await expect(record).toBeFocused();
      } else {
        await expect(record).toHaveCount(0);
        await expect(link).toHaveCount(0);
        await expect(notice).toContainText("Retained native failure");
        await expect(details).toBeEnabled();
      }
      await expect(editor).toHaveValue(
        "Keep this draft when revealing the error",
      );
      await expect(page.locator(".otk-session-error")).toHaveCount(0);
    },
  );
}
