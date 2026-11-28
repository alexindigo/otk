// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { cssLength } from "../../pages/css-length.ts";
import { subagents } from "../../pages/crumbs.ts";
import { viewByUrl } from "../../pages/sessions.ts";

async function expectPlainTrail(row: Locator) {
  const painted = await row.evaluate((row) =>
    // Inspect the breadcrumb's own boxes, not the shared scroll thumb,
    // status light artwork or the context meter.
    [
      row,
      ...Array.from(
        row.querySelectorAll(
          ".otk-task-crumbs, .otk-trail, .otk-trail-link, .otk-session-crumb, " +
            ".otk-trail-title, .otk-trail-title *, .otk-trail-separator, " +
            ".otk-trail-separator *",
        ),
      ),
    ].flatMap((element) =>
      [null, "::before", "::after"].flatMap((pseudo) => {
        const css = getComputedStyle(element, pseudo);
        const border = [
          css.borderTopWidth,
          css.borderRightWidth,
          css.borderBottomWidth,
          css.borderLeftWidth,
        ];
        const decoration = css.textDecorationLine !== "none" ||
          border.some((width) => width !== "0px") ||
          css.backgroundColor !== "rgba(0, 0, 0, 0)" ||
          css.backgroundImage !== "none" || css.boxShadow !== "none" ||
          !!pseudo && !["none", "normal"].includes(css.content);
        return decoration
          ? [{
            element: element.getAttribute("class") ?? element.localName,
            pseudo,
            underline: css.textDecorationLine,
            border,
            background: css.backgroundColor,
            shadow: css.boxShadow,
            content: css.content,
          }]
          : [];
      })
    )
  );
  expect(painted, "no fill, underline, shadow or bar on the resting trail")
    .toEqual([]);
}

async function expectLinkMark(crumb: Locator) {
  await expect(crumb.locator(".otk-trail-title")).toHaveCSS(
    "text-decoration-line",
    "underline",
  );
  await expect(crumb).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(crumb).toHaveCSS("box-shadow", "none");
  const inline = await cssLength(crumb, "--space-2");
  const block = await cssLength(crumb, "--space-1");
  const gaps = await crumb.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const lamp = el.querySelector(".otk-status-light")!.getBoundingClientRect();
    const title = el.querySelector(".otk-trail-title")!.getBoundingClientRect();
    return {
      left: lamp.left - box.left,
      right: box.right - title.right,
      top: Math.min(lamp.top, title.top) - box.top,
      bottom: box.bottom - Math.max(lamp.bottom, title.bottom),
    };
  });
  expect(Math.min(gaps.left, gaps.right)).toBeGreaterThanOrEqual(inline - .5);
  expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(1);
  expect(Math.min(gaps.top, gaps.bottom)).toBeGreaterThanOrEqual(block - .5);
  expect(Math.abs(gaps.top - gaps.bottom)).toBeLessThanOrEqual(1);
}

test.use({ profile: "contract-sessions-tab-groups" });
test("decisions.D67-D66-D3-ancestry-only-and-one-composer-subagent-inventory", {
  tag: ["@sessions", "@attention", "@load", "@visual", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  const root = "tstv1-otk",
    child = "tstv1-group-a",
    deep = "tstv1-trail-nested";
  const trail = page.locator(".otk-task-crumbs"),
    fit = trail.locator("[data-fit-mode]");
  const breadcrumbRow = page.locator(".otk-breadcrumb-row");
  const crumb = (id: string) => trail.locator(`[data-crumb="${id}"]`);
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
    // Each theme observes a new finished run: opening the prior one marks it seen.
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
      target: "trail-decisions",
    });
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
    await page.mouse.move(0, 999);
    await expectPlainTrail(breadcrumbRow);
    await shot("main-normal", name);
    await crumb(root).hover();
    await expectLinkMark(crumb(root));
    await shot("main-hover", name);
    await page.mouse.move(0, 999);
    await page.setViewportSize({ width: 900, height: 1000 });
    await expect.poll(ids).toEqual([root]);
    await shot("main-narrow", name);
    const control = subagents(page);
    await expect(control).toHaveAccessibleName(
      "Subagents: 1 needs you, 1 finished, 2 running", // D78
    );
    await expect(
      control.locator(".otk-status-light:visible").first(),
    )
      .toHaveAttribute(
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
      await expect(control).toHaveAccessibleName(
        id === child || id === "tstv1-trail-blocked"
          ? "Subagents: 1 needs you, 1 finished, 2 running"
          : "Subagents: 1 needs you, 2 running, 1 opened",
      );
      await control.click();
      if (id === "tstv1-trail-cont-1") {
        // D76 supersedes D72 for an explicitly opened finish: keep its row,
        // without counting it as unfinished or unseen work.
        const opened = menu.getByRole("group", { name: "Opened 1" });
        await expect(opened.locator(`[data-subagent="${id}"]`)).toBeVisible();
        await expect(menu.locator("[data-subagent]")).toHaveCount(4);
      }
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
    await page.mouse.move(0, 999);
    await expectPlainTrail(breadcrumbRow);
    for (const id of [root, child, deep]) {
      await expect(crumb(id)).toHaveJSProperty("tagName", "A");
      await expect(crumb(id)).toHaveAttribute("href", new RegExp(`${id}$`));
      const lamp = crumb(id).locator(":scope > .otk-status-light");
      await expect(crumb(id).locator(".otk-status-light")).toHaveCount(1);
      await expect(lamp).toBeVisible();
      const lampBox = (await lamp.boundingBox())!;
      const titleBox = (await crumb(id).locator(".otk-trail-title")
        .boundingBox())!;
      expect(Math.abs(
        lampBox.y + lampBox.height / 2 -
          (titleBox.y + titleBox.height / 2),
      )).toBeLessThanOrEqual(1);
    }
    await expect(trail.locator("[data-crumb][aria-current]")).toHaveCount(1);
    await expect(crumb(deep)).toHaveAttribute("aria-current", "page");
    await expect(crumb(deep)).toHaveCSS("font-weight", "500");
    const ancestorColor = await crumb(root).evaluate((el) =>
      getComputedStyle(el).color
    );
    await expect(crumb(deep)).not.toHaveCSS("color", ancestorColor);
    const chevrons = trail.locator(".otk-trail-separator:visible > svg");
    await expect(chevrons).toHaveCount(2);
    for (const chevron of await chevrons.all()) {
      await expect(chevron.locator("path")).toHaveCount(1);
    }
    await shot("deep-normal", name);
    await crumb(root).hover();
    await expectLinkMark(crumb(root));
    await shot("deep-hover", name);
    await page.mouse.move(0, 999);
    await crumb(root).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(crumb(root)).toBeFocused();
    await expect(crumb(root)).toHaveCSS("outline-width", "2px");
    await expectLinkMark(crumb(root));
    await shot("deep-focus", name);
    await crumb(root).blur();
    await page.setViewportSize({ width: 900, height: 1000 });
    await expect(fit).toHaveAttribute("data-fit-mode", "compact");
    await expect.poll(ids).toEqual([root, child, deep]);
    for (const id of [root, child]) {
      await expect(crumb(id).locator(".otk-trail-compact-title"))
        .toBeVisible();
    }
    const currentTitle = crumb(deep).locator(".otk-trail-title");
    await expect(currentTitle).toBeVisible();
    await expect(currentTitle).toHaveText("Nested verification branch tail");
    await expect(currentTitle).toHaveCSS("text-overflow", "ellipsis");
    await expect.poll(() =>
      trail.locator("[data-crumb] .otk-trail-first:visible").evaluateAll((
        nodes,
      ) =>
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
  await subagents(page).click();
  await expect(page.locator('[data-subagent="tstv1-trail-cont-0"]'))
    .toHaveCount(0);
});
