// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-sessions-panel" });
test(
  "sessions.registered-panel-lifetime-native-resize-persistence-and-fallback",
  { tag: ["@sessions", "@contracts", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    const panel = page.locator(".otk-right-panel");
    const width = () => panel.evaluate((e) => e.getBoundingClientRect().width);
    await expect.poll(width).toBe(320);
    await expect(
      page.locator("[data-panel-view=unavailable], [data-unavailable]"),
    ).toHaveCount(0);
    await page.locator('[data-panel-view="external-view"]').click();
    await expect(page.locator("[data-external-view]")).toHaveText(
      state.directory,
    );
    await expect(page.locator(".otk-project-sessions")).toHaveCount(0);
    const separator = page.getByRole("separator", {
      name: "Right panel width",
    });
    const box = await separator.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect.poll(() => separator.evaluate((e) => e.hasPointerCapture(1)))
      .toBe(true);
    await page.mouse.move(x - 80, y);
    await page.mouse.up();
    await expect.poll(width).toBe(400);
    await page.reload();
    await expect(page.locator("[data-external-view]")).toBeVisible();
    await expect.poll(width).toBe(400);
    await separator.click();
    await separator.press("End");
    await expect.poll(width).toBe(480);
    await separator.press("Home");
    await expect.poll(width).toBe(280);
    await page.locator(".otk-panel-collapse").click();
    await expect(panel).toBeHidden();
    await expect(page.locator("[data-external-view],.otk-project-sessions"))
      .toHaveCount(0);
    expect(
      await page.locator(".otk-right-rail [data-panel-view]").evaluateAll(
        (es) => es.map((e) => (e as HTMLElement).dataset.panelView),
      ),
    ).toEqual(["sessions", "timeline", "external-view"]);
    await page.locator('.otk-right-rail [data-panel-view="sessions"]').click();
    await expect(panel).toBeVisible();
    await expect(page.locator(".otk-panel-content")).toHaveAttribute(
      "aria-label",
      "Sessions",
    );
    await page.locator(".otk-panel-collapse").click();
    const external = page.locator(
      '.otk-right-rail [data-panel-view="external-view"]',
    );
    await external.focus();
    await external.press("Enter");
    await expect(page.locator("[data-external-view]")).toBeVisible();
    await page.locator(".otk-panel-collapse").click();
    await expect(panel).toBeHidden();
    await page.reload();
    await expect(panel).toBeHidden();
    await page.getByRole("button", { name: "Open right panel", exact: true })
      .click();
    await expect(page.locator("[data-external-view]")).toBeVisible();
    await expect.poll(width).toBe(280);
    const prefs = await state.product("prefs.get", {});
    expect(prefs.shellLayout).toMatchObject({
      rightView: "external-view",
      rightWidth: 280,
      rightCollapsed: false,
    });
    await state.product("prefs.set", {
      key: "shellLayout",
      value: { ...prefs.shellLayout, rightView: "uninstalled-view" },
    });
    await expect(page.locator("[data-panel-view=sessions]")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect((await state.product("prefs.get", {})).shellLayout.rightView).toBe(
      "uninstalled-view",
    );
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect.poll(() =>
      page.evaluate(() =>
        Math.abs(
          document.querySelector(".otk-main")!.getBoundingClientRect().right -
            document.querySelector(".otk-right-panel")!.getBoundingClientRect()
              .left,
        )
      )
    ).toBeLessThan(.5);
  },
);
