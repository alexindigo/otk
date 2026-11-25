// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { cssLength } from "../../pages/css-length.ts";
import { viewByUrl } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-tab-groups" });
test("decisions.D67-D66-D3-ancestry-only-and-one-composer-subagent-inventory", {
  tag: ["@sessions", "@attention", "@load", "@visual", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
    target: "trail-decisions",
  });
  const root = "tstv1-otk",
    child = "tstv1-group-a",
    deep = "tstv1-trail-nested";
  const trail = page.locator(".otk-task-crumbs"),
    fit = trail.locator("[data-fit-mode]");
  const ids = () =>
    trail.locator("[data-crumb]").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-crumb"))
    );
  const shot = (name: string, theme: string) =>
    page.screenshot({
      path: process.env.OTK_TRAIL_SCREENSHOTS
        ? `${process.env.OTK_TRAIL_SCREENSHOTS}/trail-${name}-${theme}.png`
        : info.outputPath(`trail-${name}-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
  for (
    const [name, theme] of [["dark", "otk-dark"], ["linen", "otk-light"], [
      "stone",
      "otk-light-stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await viewByUrl(state, page, root);
    await page.setViewportSize({ width: 1920, height: 1000 });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await expect.poll(ids).toEqual([root]);
    await expect(trail.locator(`[data-crumb="${root}"]`)).toHaveText(
      "comm#ark | main",
    );
    await expect(trail.locator(".otk-folded-crumbs,.otk-trail-menu"))
      .toHaveCount(0);
    await shot("main-normal", name);
    await page.setViewportSize({ width: 900, height: 1000 });
    await expect.poll(ids).toEqual([root]);
    await shot("main-narrow", name);
    const control = page.getByRole("button", {
      name: "Subagents",
      exact: true,
    });
    await expect(control).toHaveText("4 subagents");
    await expect(control.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "blocked",
    );
    await control.click();
    const menu = page.getByRole("menu", { name: "Subagents", exact: true });
    await expect(menu.locator("[data-subagent]")).toHaveCount(4);
    for (
      const id of [child, "tstv1-trail-blocked", "tstv1-trail-cont-1", deep]
    ) await expect(menu.locator(`[data-subagent="${id}"]`)).toBeVisible();
    for (let n = 0; n < 60; n++) {
      if (n !== 1) {
        await expect(menu.locator(`[data-subagent="tstv1-trail-cont-${n}"]`))
          .toHaveCount(0);
      }
    }
    for (const id of ["tstv1-group-b", "tstv1-group-quiet"]) {
      await expect(menu.locator(`[data-subagent="${id}"]`)).toHaveCount(0);
    }
    for (const id of [child, deep]) {
      await expect(menu.locator(`[data-subagent="${id}"] .otk-subagent-time`))
        .toContainText("14m");
    }
    const rowHeight = await cssLength(menu, "--menu-row-height");
    await expect.poll(() =>
      menu.locator("[data-subagent]").evaluateAll(
        (rows, rowHeight) =>
          rows.every((row) => {
            const title = row.querySelector(".otk-subagent-name")!
                .getBoundingClientRect(),
              time = row.querySelector(".otk-subagent-time")!
                .getBoundingClientRect();
            return Math.abs(title.height - rowHeight) <= .5 &&
              time.left >= title.right &&
              Math.abs(
                  (time.top + time.bottom - title.top - title.bottom) / 2,
                ) <=
                1;
          }),
        rowHeight,
      )
    ).toBe(true);
    await shot("subagents-open", name);
    for (
      const id of [child, "tstv1-trail-blocked", "tstv1-trail-cont-1", deep]
    ) {
      await menu.locator(`[data-subagent="${id}"] .otk-subagent-name`).click();
      await expect(page).toHaveURL(new RegExp(`${id}$`));
      await expect.poll(async () => (await ids()).at(-1)).toBe(id);
      await expect(control).toHaveText("4 subagents");
      await control.click();
    }
    await menu.locator(`[data-subagent="${child}"] .otk-subagent-name`).click();
    await expect(page).toHaveURL(new RegExp(`${child}$`));
    await expect.poll(ids).toEqual([root, child]);
    await trail.locator(`[data-crumb="${root}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${root}$`));
    await expect.poll(ids).toEqual([root]);
    await viewByUrl(state, page, deep);
    await page.setViewportSize({ width: 1920, height: 1000 });
    await expect.poll(ids).toEqual([root, child, deep]);
    await expect(fit).toHaveAttribute("data-fit-mode", "full");
    for (const id of [root, child, deep]) {
      await expect(trail.locator(`[data-crumb="${id}"]`)).toHaveAttribute(
        "href",
        new RegExp(`${id}$`),
      );
    }
    await shot("deep-normal", name);
    await page.setViewportSize({ width: 900, height: 1000 });
    await expect(fit).toHaveAttribute("data-fit-mode", "compact");
    await expect.poll(ids).toEqual([root, child, deep]);
    await expect(trail.locator(".otk-trail-compact-title:visible")).toHaveCount(
      3,
    );
    await expect.poll(() =>
      trail.locator(".otk-trail-first:visible").evaluateAll((nodes) =>
        nodes.every((node) => {
          const first = node.getBoundingClientRect(),
            control = node.closest("[data-crumb]")!.getBoundingClientRect();
          return first.left >= control.left && first.right <= control.right;
        })
      )
    ).toBe(true);
    await shot("deep-narrow", name);
    await trail.locator(`[data-crumb="${child}"]`).click();
    await expect.poll(ids).toEqual([root, child]);
    await viewByUrl(state, page, deep);
    await page.reload();
    await expect.poll(ids).toEqual([root, child, deep]);
  }
  // A selected delivered helper stays in ancestry but never enters the D66 set.
  await viewByUrl(state, page, "tstv1-trail-cont-0");
  await expect.poll(ids).toEqual([root, "tstv1-trail-cont-0"]);
  await page.getByRole("button", { name: "Subagents", exact: true }).click();
  await expect(page.locator('[data-subagent="tstv1-trail-cont-0"]'))
    .toHaveCount(0);
});
