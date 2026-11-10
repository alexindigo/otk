// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { prompt } from "../../pages/composer.ts";
import { wire } from "../../fixtures/wire.ts";

for (const supported of [true, false]) {
  test.describe(
    supported
      ? "resource attachment capability"
      : "resource catalog without attachment capability",
    () => {
      test.use({
        profile: supported
          ? "contract-composer-resource-attachments"
          : "contract-composer-no-resource-attachments",
      });
      for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
        test(`composer.resource-attachments-${supported}-${theme}`, {
          tag: ["@composer", "@isolated"],
        }, async ({ isolatedState: state, page }, info) => {
          const frames = await wire(page);
          await state.product("prefs.set", { key: "theme", value: theme });
          await page.goto(`${state.url}/#/local/tstv1-core`);
          await prompt(page).fill("@spec");
          await expect.poll(() =>
            frames.received.some((frame) =>
              frame.t === "catalog.chunk" && frame.kind === "resources"
            )
          ).toBe(true);
          const menu = page.locator(".otk-autocomplete");
          await expect(menu).toContainText("specification.md");
          await expect(menu.locator("button")).toHaveCount(supported ? 2 : 1);
          await expect(
            menu.locator("button").filter({
              hasText: "MCP resource attachment",
            }),
          ).toHaveCount(supported ? 1 : 0);
          await menu.locator("button").first().hover();
          await page.screenshot({
            path: info.outputPath(
              `resource-attachments-${supported}-${theme}.png`,
            ),
            fullPage: true,
          });
          if (!supported) {
            await prompt(page).press("Enter");
            await expect(page.locator(".otk-prompt-chips")).toContainText(
              "@specification.md",
            );
            await expect(page.locator(".otk-prompt-chips")).not.toContainText(
              "otk-fixture://",
            );
          }
        });
      }
    },
  );
}
