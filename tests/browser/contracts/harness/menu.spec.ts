// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";

test(
  "harness.menu-readiness",
  { tag: ["@harness", "@menus", "@contracts"] },
  async ({ page }) => {
    await page.setContent(
      '<span class="otk-context-menu" data-open="false"><div id="panel" class="otk-popover-panel" popover><div class="otk-surface"><div role="menu"><button role="menuitem">Action</button></div></div></div></span>',
    );
    const premature = await page.evaluate(() => {
      const owner = document.querySelector<HTMLElement>(".otk-context-menu")!,
        panel = document.querySelector<HTMLElement>("#panel")!;
      panel.addEventListener("toggle", () => {
        owner.dataset.open = String(panel.matches(":popover-open"));
        if (panel.matches(":popover-open")) {
          panel.querySelector("button")!.focus();
        }
      });
      panel.showPopover();
      return {
        dom: !!document.querySelector(":popover-open [role=menu]"),
        owner: owner.dataset.open,
      };
    });
    expect(premature).toEqual({ dom: true, owner: "false" });
    await expect(page.locator(".otk-context-menu")).toHaveAttribute(
      "data-open",
      "true",
    );
    await expect(page.getByRole("menuitem", { name: "Action" })).toBeFocused();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect.poll(() =>
      page.locator(".otk-surface").evaluate(async (surface) => {
        const box = surface.getBoundingClientRect();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const next = surface.getBoundingClientRect();
        return box.width > 0 && box.height > 0 &&
          ["x", "y", "width", "height"].every((key) =>
            Reflect.get(box, key) === Reflect.get(next, key)
          );
      })
    ).toBe(true);
  },
);
