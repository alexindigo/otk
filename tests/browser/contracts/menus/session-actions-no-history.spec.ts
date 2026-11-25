// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({
  profile: "contract-menus-session-actions-no-history",
  viewport: { width: 1440, height: 1000 },
  timezoneId: "America/Los_Angeles",
});
for (
  const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
    "otk-light-stone",
    "stone",
  ]]
) {
  test(
    `session-actions no-history Revert remains usable with an explicit pre-send warning ${theme}`,
    {
      tag: ["@menus", "@sessions", "@revert", "@messages", "@isolated"],
    },
    async ({ isolatedState: state, page }, info) => {
      await state.product("prefs.set", { key: "theme", value: theme });
      await page.goto(`${state.url}/#/local/tstv1-core`);
      const strip = page.locator(".otk-revert-group");
      const warning = strip.locator(".otk-revert-warning");
      const revert = async () => {
        await page.locator(".otk-user-bubble").click({ button: "right" });
        await page.getByRole("menuitem", {
          name: "Revert code changes",
          exact: true,
        }).click();
        await page.getByRole("button", { name: "Confirm revert", exact: true })
          .click();
        await expect(strip).toHaveAttribute("data-boundary", "prompt-v4");
        await expect(warning).toHaveText(
          "This branch can't be kept after you send (this server doesn't provide prompt history).",
        );
        await expect(warning).toBeVisible();
        await expect(strip).toHaveAttribute("data-phase", "staged");
        await expect(page.locator(".otk-composer-notice")).toHaveCount(0);
        await page.screenshot({
          path: info.outputPath(`revert-staged-${name}.png`),
          animations: "disabled",
        });
      };
      await revert();
      await page.reload();
      await expect(warning).toBeVisible();
      await page.getByRole("button", {
        name: "Restore conversation",
        exact: true,
      }).click();
      await expect(strip).toHaveCount(0);
      await expect(page.locator(".otk-user-bubble")).toContainText(
        "Keep session actions reversible",
      );
      await revert();
      const input = page.locator("textarea[name=prompt]");
      await input.fill("Continue without a saved earlier branch");
      await page.screenshot({
        path: info.outputPath(`rv2-no-history-${name}.png`),
        fullPage: true,
      });
      await expect(page.locator(".otk-send-button")).toBeEnabled();
      await input.press("Enter");
      await expect(page.locator(".otk-permanence-choice")).toContainText(
        "Sending makes the revert permanent",
      );
      await page.getByRole("button", { name: "Send anyway", exact: true })
        .click();
      await expect.poll(async () =>
        (await state.observe<{ calls: unknown[] }>()).calls
      )
        .toContainEqual(["prompt", "tstv1-core"]);
      await expect(strip).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Saved earlier branches/ }))
        .toHaveCount(
          0,
        );
      expect(
        await page.evaluate(() =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith("otk.branch-history.v1/")
          )
        ),
      ).toEqual([]);
      await page.reload();
      await expect(warning).toHaveCount(0);
    },
  );
}
