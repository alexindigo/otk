// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import {
  stripContract,
  stripGeometry,
  stripShot,
  stripThemes,
} from "../pages/task-strip.ts";
import {
  shellContained,
  sidebarWheelContained,
} from "../themes/containment.ts";

test.use({ profile: "contract-scale-overflow" });
test(
  "scale.300-task-tabs-scroll-in-one-row",
  { tag: ["@scale"] },
  async ({ isolatedState: state, page }, info) => {
    const { ids, tasks } = await state.observe<
      { ids: string[]; tasks: string[] }
    >();
    expect(tasks).toHaveLength(300);
    await page.goto(`${state.url}/#/local/${ids[0]}`);
    await expect(page.locator("textarea[name=prompt]")).toBeVisible();
    const samples = [];
    for (const width of [600, 800, 1280, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      // Selecting through the URL exercises selection reveal independently of Playwright's click scrolling.
      await page.goto(`${state.url}/#/local/${ids[150]}`);
      await expect(page.locator(`[data-tab="${tasks[150]}"]`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      samples.push({ width, geometry: await stripContract(page, 300) });
      await page.goto(`${state.url}/#/local/${ids[250]}`);
      await expect.poll(async () =>
        (await stripGeometry(page)).full.includes(tasks[250])
      ).toBe(true);
      await page.setViewportSize({ width: width - 50, height: 800 });
      await expect.poll(async () =>
        (await stripGeometry(page)).full.includes(tasks[250])
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${state.url}/#/local/${ids[150]}`);
    await expect(page.locator(`[data-tab="${tasks[150]}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(async () =>
      (await stripGeometry(page)).full.includes(tasks[150])
    ).toBe(true);
    for (const theme of stripThemes) {
      await state.product("prefs.set", { key: "theme", value: theme.id });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme.id,
      );
      await expect.poll(() =>
        page.locator("html").evaluate((el) => getComputedStyle(el).colorScheme)
      ).toBe(theme.mode);
      await stripShot(page, info, `u4-300-selected-${theme.name}`);
      // Deliberately page away from selection to review both edge controls independently.
      await page.locator(".otk-task-list").evaluate((el) => {
        el.scrollLeft = 10000;
      });
      await expect(page.locator(".otk-edge-triangle")).toHaveCount(2);
      await stripShot(page, info, `u4-300-tabs-${theme.name}`);
      const next = page.getByRole("button", {
        name: "Next tasks",
        exact: true,
      });
      await next.hover();
      const box = (await next.boundingBox())!;
      const clip = {
        x: box.x - 4,
        y: box.y - 4,
        width: box.width + 8,
        height: box.height + 8,
      };
      await page.screenshot({
        clip,
        path: info.outputPath(`u4-triangle-hover-${theme.name}.png`),
      });
      await next.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(next).toBeFocused();
      await page.screenshot({
        clip,
        path: info.outputPath(`u4-triangle-focus-${theme.name}.png`),
      });
      await page.goto(`${state.url}/#/local/${ids[250]}`);
      await expect(page.locator(`[data-tab="${tasks[250]}"]`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.goto(`${state.url}/#/local/${ids[150]}`);
      await expect.poll(async () =>
        (await stripGeometry(page)).full.includes(tasks[150])
      ).toBe(true);
    }
    await info.attach("strip-measurements", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
  },
);

test("scale.shell-contained-with-300-required-tabs", {
  tag: ["@scale", "@sessions"],
}, async ({ isolatedState: state, page }) => {
  const { ids, tasks } = await state.observe<
    { ids: string[]; tasks: string[] }
  >();
  expect(tasks).toHaveLength(300);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "thaw",
  });
  await state.product("layout.patch", {
    leftCollapsed: false,
    rightCollapsed: true,
  });
  await page.goto(`${state.url}/#/local/${ids[0]}`);
  await expect(page.locator("[data-tab] .otk-status-light[data-state=working]"))
    .toHaveCount(300);
  for (const width of [400, 600, 800, 1280, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await shellContained(page);
    await sidebarWheelContained(page);
    const g = await stripGeometry(page);
    expect(g.height).toBe(g.expected);
  }
});
