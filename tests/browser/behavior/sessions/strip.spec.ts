// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { expect } from "../../fixtures/evidence.ts";
import {
  assertPagingStep,
  stripContract,
  stripGeometry,
  stripShot,
  stripThemes,
} from "../../pages/task-strip.ts";
import { activity } from "../../pages/sessions.ts";
import { subagent, subagents } from "../../pages/crumbs.ts";

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
      await expect(page.locator("[data-crumb=tstv1-helper]")).toHaveCount(0);
      await subagents(page).click();
      await expect(subagent(page, "tstv1-helper")).toBeVisible();
      await page.goto(`${state.url}/#/local/tstv1-otk/tstv1-helper`);
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

test("sessions.tab-paging-rejects-an-inert-fixture-button", {
  tag: ["@sessions", "@contracts"],
}, async ({ page }) => {
  await page.setContent(
    `<div class="otk-task-strip" style="--chrome-header-height:40px"><div class="otk-task-list" style="display:flex;width:110px;overflow:auto"><button data-tab="first" style="flex:0 0 100px">First</button><button data-tab="last" style="flex:0 0 100px">Last</button></div><button data-direction="next" aria-label="Next tasks">Next</button></div>`,
  );
  const before = await stripGeometry(page);
  await page.getByRole("button", { name: "Next tasks" }).click();
  const after = await stripGeometry(page);
  expect(() => assertPagingStep(before, after, "next")).toThrow();
});
