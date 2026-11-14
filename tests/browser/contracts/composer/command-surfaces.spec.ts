// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/composer.ts";

test.use({ profile: "composer-commands" });
test(
  "composer.command-surfaces-compact-is-discoverable-through-both-generic-projections",
  {
    tag: ["@composer", "@menus", "@isolated"],
  },
  async ({ isolatedState: state, page }, info) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Command registry",
    });
    await openSession(state, page, session.id);
    await expect(page.locator(".otk-composer-model-name")).not.toHaveText("");
    await page.evaluate(() => document.fonts.ready);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await prompt(page).fill("/compact");
      await expect(
        page.locator(".otk-autocomplete button").filter({
          hasText: "/compact",
        }),
      ).toBeVisible();
      await page.screenshot({ path: info.outputPath(`${theme}-slash.png`) });
      await prompt(page).press("Escape");
      await prompt(page).fill("Keep this draft");
      await page.keyboard.press("Control+k");
      const search = page.getByRole("textbox", { name: "Find a command" });
      await search.fill("compact");
      await expect(page.locator('[data-command="session.compact"]'))
        .toBeVisible();
      await page.screenshot({ path: info.outputPath(`${theme}-palette.png`) });
      await page.keyboard.press("Escape");
      await expect(prompt(page)).toHaveValue("Keep this draft");
    }
  },
);
