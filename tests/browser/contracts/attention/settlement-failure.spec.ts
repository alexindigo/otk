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
      if (kind === "question") {
        await expect(primary).toBeDisabled();
        await expect(page.getByText("Sending answer", { exact: true }))
          .toHaveCount(1);
        await expect(page.locator(".otk-question-dock dd")).toHaveText("A");
        await expect(page.getByRole("button", { name: "B", exact: true }))
          .toHaveCount(0);
        await primary.dispatchEvent("click");
        await expect(page.getByRole("alert")).toHaveCount(0);
        await expect(page.locator("[data-settlement-frames]")).toHaveAttribute(
          "data-settlement-frames",
          "1",
        );
        return;
      }
      if (kind === "permission") {
        await page.getByRole("button", { name: "Reject", exact: true }).click();
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
      // Forms retain in-flow field feedback; only the joined composer row
      // moves certainty into Details.
      const owner = kind === "form"
        ? failure
        : page.locator(".otk-failure-content.is-feedback").filter({
          has: failure,
        });
      if (kind === "form") {
        await expect(owner).toContainText("This one was not sent");
      } else {
        await expect(owner).toHaveCount(1);
        const details = owner.locator(".otk-failure-detail-body");
        await expect(details).toHaveCount(0);
        // Issue 2.114: the alert announces the headline; the notice owns
        // the sibling Details disclosure and its recovery text.
        const trigger = owner.getByRole("button", {
          name: "Details",
          exact: true,
        });
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(details.locator(".otk-failure-recovery")).toHaveText(
          "This one was not sent",
        );
      }
      // UI conventions suppress the open session's inline self-target. The
      // fixture's captured target and single-frame admission stay authoritative.
      await expect(owner.getByRole("link")).toHaveCount(0);
      await expect(owner).not.toContainText("Reply target");
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
