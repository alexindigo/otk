// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { scenario, seed } from "../../pages/attention.ts";

test.use({ profile: "contract-attention-auto" });
test(
  "attention.permission-refusal-shows-safe-reason-once-and-keeps-diagnostics-private",
  {
    tag: ["@attention", "@transport", "@isolated"],
  },
  async ({ isolatedState: state, page }, info) => {
    const session = await seed(state, "Refused automatic permission");
    await openSession(state, page, session.id);
    await scenario(state, "fail", session.nativeID);
    await page.locator('[data-panel-view="activity"]').click();
    await page.reload();
    const activity = page.locator(".otk-permission-activity");
    const failed = activity.locator("[data-activity]").filter({
      has: page.getByRole("alert"),
    });
    await expect(failed).toHaveCount(1);
    await expect(failed).toContainText("Auto");
    await expect(failed).toContainText("Allow once");
    await expect(failed).toContainText("Refused automatic permission");
    await failed.getByRole("button", { name: "Details", exact: true }).click();
    await expect(failed).toContainText(
      "Native policy refused the permission reply.",
    );
    await expect(failed).toContainText(
      "Review this request before trying again.",
    );
    await expect(activity).not.toContainText("Stored failure fixture");
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.screenshot({
        path: info.outputPath(`permission-refusal-${theme}.png`),
      });
    }
  },
);
