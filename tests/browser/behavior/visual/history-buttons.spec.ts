// SPDX-License-Identifier: LGPL-3.0-only
import type { Page, TestInfo } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({
  profile: "contract-sessions-default",
  viewport: { width: 1440, height: 900 },
});

const themes = {
  dark: "otk-dark",
  linen: "otk-light",
  stone: "otk-light-stone",
};

async function geometry(
  page: Page,
  collapsed: boolean,
  info: TestInfo,
  state: string,
) {
  const history = page.getByRole("navigation", { name: "Session history" });
  await expect(history.getByRole("button")).toHaveCount(2);
  const measured = await history.evaluate((nav) => {
    const rect = (el: Element) =>
      el.getBoundingClientRect().toJSON() as DOMRect;
    const button = Array.from(nav.querySelectorAll("button"), (el) => {
      const box = rect(el),
        icon = rect(
          el.querySelector<SVGPathElement>("svg > path")!.ownerSVGElement!,
        );
      return {
        box,
        gaps: [
          icon.left - box.left,
          icon.top - box.top,
          box.right - icon.right,
          box.bottom - icon.bottom,
        ],
      };
    });
    const rail = nav.closest(".otk-sidebar-rail")!;
    return {
      button,
      rail: rect(rail),
      header: rect(rail.querySelector(".otk-rail-header")!),
      brand: rect(rail.querySelector(".otk-inbox-brand strong")!),
      search: rect(rail.querySelector(".otk-inbox-search")!),
      toggle: rect(document.querySelector(".otk-corner-left")!),
    };
  });
  await info.attach(`geometry-${state}`, {
    body: JSON.stringify(measured),
    contentType: "application/json",
  });
  const { button: [back, forward], rail, header, brand, search, toggle } =
    measured;
  const near = (a: number, b: number) =>
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  for (const { box, gaps } of [back, forward]) {
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5.5);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    expect(box.left).toBeGreaterThanOrEqual(rail.left);
    expect(box.right).toBeLessThanOrEqual(rail.right);
    if (collapsed) {
      expect(box.top).toBeGreaterThanOrEqual(header.bottom);
      expect(box.bottom).toBeLessThan(search.top);
      near(box.left + box.width / 2, search.left + search.width / 2);
    } else {
      expect(box.left).toBeGreaterThan(toggle.right);
      expect(box.right).toBeLessThan(brand.left);
      expect(box.top).toBeGreaterThanOrEqual(header.top);
      expect(box.bottom).toBeLessThanOrEqual(header.bottom);
      near(box.top + box.height / 2, toggle.top + toggle.height / 2);
    }
  }
  if (collapsed) expect(back.box.bottom).toBeLessThan(forward.box.top);
  else expect(back.box.right).toBeLessThan(forward.box.left);
}

for (const [theme, id] of Object.entries(themes)) {
  test(
    `visual.history-buttons-${theme}`,
    { tag: ["@visual", "@contracts"] },
    async ({ isolatedState: state, page }, info) => {
      await state.product("prefs.set", { key: "theme", value: id });
      await state.product("layout.patch", {
        leftCollapsed: false,
        rightCollapsed: false,
        rightView: "sessions",
      });
      const first = `${state.url}/#/local/tstv1-newest-root`;
      const second = `${state.url}/#/local/tstv1-atmosphera`;
      const history = page.getByRole("navigation", { name: "Session history" });
      const back = history.getByRole("button").first(),
        forward = history.getByRole("button").last();
      const shot = async (view: string) => {
        const name = `back-forward-${view}-${theme}`;
        const path = info.outputPath(`${name}.png`);
        await page.screenshot({ path, fullPage: true, animations: "disabled" });
        await info.attach(name, { path, contentType: "image/png" });
      };
      await page.goto(first);
      await expect(page.locator("html")).toHaveAttribute("data-otk-theme", id);
      await expect(page.locator('[data-crumb="tstv1-newest-root"]'))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Collapse projects" }))
        .toBeVisible();
      await shot("expanded-fresh");
      await expect(back).toBeDisabled();
      await expect(forward).toBeDisabled();
      await geometry(page, false, info, "fresh");
      await page.goto(second);
      await expect(page.locator('[data-crumb="tstv1-atmosphera"]'))
        .toBeVisible();
      await expect(back).toHaveAttribute("data-state", "live");
      await back.hover();
      await geometry(page, false, info, "hover");
      await shot("expanded-hover");
      await back.click();
      await expect(page).toHaveURL(first);
      // Enter keyboard modality and move from the preceding corner toggle to the only
      // enabled history button, so this captures a real :focus-visible ring.
      await page.locator(".otk-corner-right").focus();
      await page.keyboard.press("Tab");
      await expect(forward).toBeFocused();
      await expect(forward.and(history.locator("button:focus-visible")))
        .toHaveCount(1);
      await geometry(page, false, info, "focus");
      await shot("expanded-focus");
      await forward.click();
      await expect(page).toHaveURL(second);
      await page.getByRole("button", { name: "Collapse projects" }).click();
      await expect(page.getByRole("button", { name: "Expand projects" }))
        .toBeVisible();
      await geometry(page, true, info, "collapsed");
      await shot("collapsed");
    },
  );
}
