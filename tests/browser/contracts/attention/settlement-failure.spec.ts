// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-visual-styles" });
for (const kind of ["permission", "question", "form"] as const) {
  test(
    `attention.settlement-conflict-${kind}-has-one-owner-and-no-second-reply`,
    {
      tag: ["@attention", "@composer", "@visual", "@isolated"],
    },
    async ({ isolatedState: state, page }, info) => {
      await page.goto(`${state.url}/?scene=settlement-conflicts&kind=${kind}`);
      await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
      const primary = page.locator("[data-primary-action]");
      await expect(primary).toBeVisible();
      const original = await primary.elementHandle();
      if (kind === "permission") {
        await page.getByRole("button", { name: "Reject", exact: true }).click();
      } else if (kind === "question") {
        await page.getByRole("button", { name: "B", exact: true }).click();
        await primary.click();
        await expect(page.getByRole("tab", { name: "Confirm", exact: true }))
          .toHaveAttribute("aria-selected", "true");
      } else {
        await page.locator('[data-field="choice"] input').fill("B");
        await primary.click();
        await expect(primary).toHaveText("Send answers");
      }
      await primary.click();
      const failure = page.getByRole("alert");
      await expect(failure).toHaveCount(1);
      await expect(failure).toContainText(
        "A different response was already sent for this request",
      );
      await expect(failure).toContainText("This one was not sent");
      await expect(
        failure.getByRole("link", { name: "Reply target", exact: true }),
      )
        .toHaveAttribute("href", "#/remote/tstv1-settlement-fixture");
      await expect(page.locator("[data-settlement-frames]")).toHaveAttribute(
        "data-settlement-frames",
        "1",
      );
      await expect(primary).toBeVisible();
      expect(
        await primary.evaluate((node, before) => node === before, original),
      ).toBe(true);
      for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
        await page.evaluate(`styleTest.theme('${theme}')`);
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await info.attach(`settlement-${kind}-${theme}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      }
    },
  );
}
