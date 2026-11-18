// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-messages-pending-inventory" });
test(
  "messages.unsupported-inbox-loads-transcript-with-one-notice-and-no-repeated-requests",
  {
    tag: ["@messages", "@transport", "@contracts"],
  },
  async ({ isolatedState: state, page }, info) => {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "fail",
    });
    const values = await state.observe<
      { form: string; permission: string; inboxReads: number }
    >();
    await openSession(state, page, values.form);
    const notice = page.locator(".otk-session-notice");
    await expect(page.locator(".otk-messages")).toContainText(
      "The transcript is still available.",
    );
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveText(
      "Queued messages aren't available on this server.",
    );
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toHaveClass(/is-info/);
    await expect(notice).not.toHaveClass(/is-error/);
    await expect(notice.getByRole("button")).toHaveCount(0);
    await expect(
      page.getByRole("alert").filter({
        hasText: "Queued messages aren't available on this server.",
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Retry messages", exact: true }),
    ).toHaveCount(0);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await expect(notice).toHaveCSS(
        "color",
        await page.locator(".otk-messages").evaluate((element) =>
          getComputedStyle(element).color
        ),
      );
      await info.attach(`unsupported-inbox-${theme}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    await page.reload();
    await expect(notice).toHaveCount(1);
    await expect(page.locator(".otk-messages")).toContainText(
      "The transcript is still available.",
    );
    await openSession(state, page, values.permission);
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveText(
      "Queued messages aren't available on this server.",
    );
    await openSession(state, page, values.form);
    await expect(notice).toHaveCount(1);
    expect(
      (await state.observe<{ inboxReads: number }>()).inboxReads -
        values.inboxReads,
    ).toBe(1);
  },
);
