// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-visual-styles" });
for (const surface of ["palette", "menu", "message", "notification"]) {
  for (const replace of [false, true]) {
    test(
      `menus.command-failure-label-${surface}-${
        replace ? "replaced" : "retained"
      }`,
      {
        tag: ["@menus", "@isolated"],
      },
      async ({ isolatedState: state, page }) => {
        await page.goto(
          `${state.url}/?scene=command-failures&surface=${surface}`,
        );
        if (surface === "menu") {
          await page.getByRole("button", {
            name: "Open command menu",
            exact: true,
          }).click();
          await page.getByRole("menuitem", {
            name: "Original projected action",
            exact: true,
          }).click();
        } else if (surface === "palette") {
          await page.locator('[data-command="consumer.private-copy"]').click();
        } else {
          const name = surface === "message"
            ? "Original projected action"
            : "Original notification action";
          await page.getByRole("button", { name, exact: true }).click();
        }
        await expect(page.locator("[data-started]")).toHaveText("true");
        if (replace) {
          // Keep the open menu's origin/focus lifetime; this is registry churn,
          // not an outside click that would intentionally dismiss its feedback.
          await page.locator("[data-replace]").evaluate((
            el: HTMLButtonElement,
          ) => el.click());
          await expect(page.locator("[data-replaced]")).toHaveText("true");
        }
        await page.locator("[data-reject]").evaluate((el: HTMLButtonElement) =>
          el.click()
        );
        const feedback = surface === "notification"
          ? page.locator('.otk-toast[data-kind="error"]')
          : page.getByRole("alert");
        const label = surface === "palette"
          ? "Original command"
          : surface === "notification"
          ? "Original notification action"
          : "Original projected action";
        await expect(feedback).toContainText(`${label} failed`);
        await expect(feedback).toContainText("OTK has no further details");
        await expect(feedback).not.toContainText("Replacement");
        await expect(feedback).not.toContainText("consumer.private-copy");
        await expect(feedback).not.toContainText("Private command diagnostic");
        if (surface === "message") {
          await expect(feedback).not.toContainText("Captured target");
          await expect(feedback.getByRole("link")).toHaveCount(0);
        }
      },
    );
  }
}
