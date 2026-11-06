// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { expect } from "../../fixtures/evidence.ts";
import {
  stripContract,
  stripGeometry,
  stripShot,
  stripThemes,
} from "../../pages/task-strip.ts";
import { activity } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-tabs" });
for (const count of [2, 10]) {
  test(`sessions.${count}-task-tabs-share-one-scrolling-row`, {
    tag: ["@sessions", "@visual"],
  }, async ({ isolatedState: state, page }, info) => {
    const tasks: { id: string }[] = [];
    for (let n = 0; n < count; n++) {
      tasks.push(
        await state.product("tasks.create", {
          directory: state.directory,
          name: `Task ${n}: a long task label that ellipsizes`,
          sessions: n === 0 ? ["tstv1-otk"] : [],
        }),
      );
    }
    await state.product("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    await page.goto(`${state.url}/#/local/tstv1-otk`);
    await expect(page.locator("textarea[name=prompt]")).toBeVisible();
    const samples = [];
    for (const width of [600, 800, 1280, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator(`[data-tab="${tasks.at(-1)!.id}"]`).click();
      samples.push({ width, geometry: await stripContract(page, count) });
      await page.locator(`[data-tab="${tasks[0].id}"]`).click();
      await expect.poll(async () =>
        (await stripGeometry(page)).full.includes(tasks[0].id)
      ).toBe(true);
      await page.setViewportSize({ width: width - 50, height: 800 });
      await expect.poll(async () =>
        (await stripGeometry(page)).full.includes(tasks[0].id)
      ).toBe(true);
    }
    if (count === 2) {
      for (const theme of stripThemes) {
        await state.product("prefs.set", {
          key: "theme",
          value: theme.id,
        });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme.id,
        );
        await expect.poll(() =>
          page.locator("html").evaluate((el) =>
            getComputedStyle(el).colorScheme
          )
        ).toBe(theme.mode);
        await stripShot(page, info, `u4-2-tabs-${theme.name}`);
      }
      await activity(state, "tstv1-helper", "hold");
      await expect(
        page.locator(
          "[data-crumb=tstv1-helper][data-helper=true] .otk-status-light",
        ),
      ).toHaveAttribute("data-state", "working");
      await expect(page.locator(".otk-auto-mark")).toHaveCount(0);
      for (const theme of stripThemes) {
        await state.product("prefs.set", {
          key: "theme",
          value: theme.id,
        });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme.id,
        );
        await expect.poll(() =>
          page.locator("html").evaluate((el) =>
            getComputedStyle(el).colorScheme
          )
        ).toBe(theme.mode);
        await stripShot(page, info, `u4-working-crumb-${theme.name}`);
      }
    }
    await info.attach("strip-measurements", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
  });
}
