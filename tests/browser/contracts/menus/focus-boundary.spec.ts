// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { expect } from "../../fixtures/evidence.ts";
import { surface } from "../../themes/overlays.ts";

test.use({ profile: "contract-themes" });
test("menus.folded-menu-unpainted-focus-boundary", {
  tag: ["@menus", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  await state.product("tasks.create", {
    directory: state.directory,
    name: "Geometry task",
    sessions: Array.from(
      { length: 12 },
      (_, i) => i ? `tstv1-visual-${i}` : "tstv1-otk",
    ),
  });
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(state.url + "/#/local/tstv1-otk");
  const observations: unknown[] = [];
  for (const reduced of [false, true]) {
    await state.product("prefs.set", { key: "reducedColors", value: reduced });
    await page.locator(".otk-folded-crumbs > button").click();
    const menu = page.locator(":popover-open [role=menu]");
    await expect(menu).toBeFocused();
    await expect(menu).toHaveCSS("outline-style", "none");
    await surface(page);
    observations.push(
      await menu.evaluate((element) => {
        const css = getComputedStyle(element);
        return {
          focusVisible: element.matches(":focus-visible"),
          outlineStyle: css.outlineStyle,
          outlineWidth: css.outlineWidth,
        };
      }),
    );
    await page.keyboard.press("Escape");
    // Exercise the pointer opening again after real keyboard modality, as the
    // full sweep does between its ordinary and reduced-color collections.
    await page.keyboard.press("Control+k");
    await expect(page.locator("input[name=command-search]")).toBeFocused();
    await page.keyboard.press("Escape");
  }
  await info.attach("focus-boundaries", {
    body: JSON.stringify(observations),
    contentType: "application/json",
  });
});
