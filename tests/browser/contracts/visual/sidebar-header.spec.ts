// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-visual-inbox" });
test("visual.sidebar-toggles-follow-header-centerlines", {
  tag: ["@visual", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url);
  const left = page.locator(".otk-corner-left");
  const right = page.locator(".otk-corner-right");
  await expect(left).toBeEnabled();
  await page.locator("html").evaluate((root) => {
    root.style.setProperty("--chrome-header-height", "68px");
  });
  for (const collapsed of [false, true]) {
    await state.product("layout.patch", {
      leftCollapsed: collapsed,
      rightCollapsed: collapsed,
    });
    await expect(left).toHaveAttribute("aria-expanded", String(!collapsed));
    await expect(right).toHaveAttribute("aria-expanded", String(!collapsed));
    for (
      const [toggle, header] of [
        [left, ".otk-project-inbox .otk-rail-header"],
        [
          right,
          collapsed ? ".otk-right-rail .otk-rail-header" : ".otk-panel-icons",
        ],
      ] as const
    ) {
      const control = (await toggle.boundingBox())!;
      const row = (await page.locator(header).boundingBox())!;
      expect.soft(
        Math.abs(control.y + control.height / 2 - row.y - row.height / 2),
        `${header} control and header must share a centerline`,
      ).toBeLessThanOrEqual(0.5);
    }
  }
});
