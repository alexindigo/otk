// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { sidebarGeometry } from "./sidebar-geometry.ts";

test.use({
  profile: "contract-visual-styles",
  timezoneId: "America/Los_Angeles",
});
test("visual.sidebar-row-tracks-align-and-never-overlap", {
  tag: ["@visual", "@projects", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const width of [200, 297.96484375, 360]) {
    for (const scale of [1, 1.25]) {
      await page.goto(`${state.url}/?scene=sidebar-rows&width=${width}`);
      await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
      await page.evaluate((scale) =>
        document.documentElement.style.setProperty(
          "--otk-scale",
          String(scale),
        ), scale);
      await page.evaluate(() => document.fonts.ready);
      expect(
        Math.abs(
          (await page.locator(".otk-project-inbox").boundingBox())!.width -
            width,
        ),
      ).toBeLessThanOrEqual(.5);
      for (const name of ["Archived", "Inactive"]) {
        await page.getByRole("button", { name: new RegExp("^" + name) })
          .click();
      }
      await sidebarGeometry(page);
      for (const group of ["active", "archived", "discovered", "inactive"]) {
        await expect(
          page.locator(`.otk-project-row[data-group="${group}"]`).first(),
        ).toBeVisible();
      }
      for (const button of await page.locator(".otk-project-open").all()) {
        await button.click();
        await sidebarGeometry(page);
      }
      const root = page.locator(".otk-project-tree").filter({
        has: page.locator('[data-project="/projects/atmosphera"]'),
      }).first();
      const toggle = root.locator(
        ":scope > .otk-tree-heading .otk-tree-toggle",
      );
      await toggle.click();
      await expect(page.locator('[data-project="/projects/atmosphera.branch"]'))
        .toHaveCount(0);
      await sidebarGeometry(page);
      await toggle.click();
      for (const name of ["Archived", "Discovered", "Inactive"]) {
        const header = page.getByRole("button", {
          name: new RegExp("^" + name),
        });
        await header.click();
        await sidebarGeometry(page);
        await header.click();
        await sidebarGeometry(page);
      }
      await page.goto(`${state.url}/?scene=sidebar-rows&collapsed=1`);
      await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
      await page.evaluate(
        (scale) =>
          document.documentElement.style.setProperty(
            "--otk-scale",
            String(scale),
          ),
        scale,
      );
      await sidebarGeometry(page, true);
    }
  }
});
