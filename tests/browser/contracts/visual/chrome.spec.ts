// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { independentPage } from "../../pages/visual.ts";
test.use({ profile: "contract-visual-inbox" });
const tags = { tag: ["@visual", "@isolated"] };
test(
  "visual.rapid-layout-independent-fields-broadcast-and-reload",
  tags,
  async ({ isolatedState: state, page, browser }) => {
    await page.goto(state.url);
    await expect(page.locator(".otk-inbox-resizer")).toBeAttached();
    await expect(
      page.getByRole("button", { name: "Collapse projects", exact: true }),
    ).toBeEnabled();
    const before = (await state.product("prefs.get", {})).shellLayout;
    await page.evaluate(() => {
      document.querySelector(".otk-inbox-resizer")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
      (document.querySelector(
        '[aria-label="Collapse projects"]',
      ) as HTMLElement).click();
      (document.querySelector('[aria-label="Open right panel"]') as HTMLElement)
        .click();
    });
    const expected = {
      ...before,
      leftWidth: 360,
      leftCollapsed: true,
      rightCollapsed: false,
    };
    await expect.poll(async () =>
      (await state.product("prefs.get", {})).shellLayout
    ).toEqual(expected);
    const { page: other, errors } = await independentPage(state, browser);
    await other.goto(state.url);
    for (const p of [page, other]) {
      await expect(p.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        "true",
      );
      await expect(p.locator(".otk-right-panel")).toBeVisible();
      expect((await p.locator(".otk-project-inbox").boundingBox())!.width).toBe(
        48,
      );
    }
    await page.reload();
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator(".otk-right-panel")).toBeVisible();
    await page.getByRole("button", { name: "Expand projects", exact: true })
      .click();
    await expect.poll(() =>
      page.locator(".otk-project-inbox").evaluate((el) =>
        el.getBoundingClientRect().width
      )
    ).toBe(360);
    expect(errors).toEqual([]);
  },
);
test(
  "visual.rail-actions-search-focus-sessions-and-restored-collapse",
  tags,
  async ({ isolatedState: state, page }) => {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
    });
    await openSession(state, page, "tstv1-otk");
    await state.product("layout.patch", {
      leftCollapsed: false,
      rightCollapsed: false,
    });
    await page.locator(".otk-corner-left").click();
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await page.locator(".otk-corner-right").click();
    await expect(page.locator(".otk-right-panel")).toBeHidden();
    const search = page.locator(".otk-inbox-search");
    await expect(search).toHaveAttribute("aria-label", "Search commands");
    await search.click();
    await expect(page.locator("input[name=command-search]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toBeFocused();
    await page.locator(".otk-right-rail [data-panel-view=sessions]").click();
    await expect(page.locator(".otk-right-panel")).toBeVisible();
    await expect(page.locator('[data-session="tstv1-otk"]')).toBeVisible();
    await page.locator(".otk-corner-right").click();
    await page.reload();
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator(".otk-right-rail [data-panel-view=sessions]"))
      .toBeEnabled();
    for (
      const [id, status] of [["tstv1-otk", "working"], [
        "tstv1-atmosphera",
        "blocked",
      ], ["tstv1-globnotes", "finished"]]
    ) {
      await expect(
        page.locator(
          `[data-project$="/projects/${
            id.slice(6)
          }"] .otk-status-light[data-state="${status}"]`,
        ),
      ).toBeVisible();
    }
    await expect(page.locator('[data-tab="tstv1-otk"]')).toBeVisible();
  },
);
test(
  "visual.project-row-hover-focus-native-menu-return-and-absent-tab-menus",
  tags,
  async ({ isolatedState: state, page }) => {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
      sessionID: "tstv1-row-action-phantom",
    });
    await state.product("projects.visit", {
      directory: state.directory,
      active: true,
    });
    await openSession(state, page, "tstv1-otk");
    await expect(page.locator('[data-tab="tstv1-row-action-phantom"]'))
      .toBeVisible();
    const row = page.locator('[data-project$="/projects/otk"]'),
      menu = row.locator(".otk-project-menu"),
      trigger = row.locator(".otk-popover-trigger");
    await page.mouse.move(600, 500);
    await page.locator("body").evaluate(() =>
      (document.activeElement as HTMLElement)?.blur()
    );
    await expect.poll(() => menu.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("0");
    const before = await row.locator(".otk-project-trailing").boundingBox();
    await row.hover();
    await expect.poll(() => menu.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");
    await expect.poll(() =>
      row.locator("time").evaluate((el) => getComputedStyle(el).opacity)
    ).toBe("0");
    expect(await row.locator(".otk-project-trailing").boundingBox()).toEqual(
      before,
    );
    await page.mouse.move(600, 500);
    await row.locator(".otk-project-open").focus();
    await expect.poll(() => menu.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");
    expect(await row.locator(".otk-project-trailing").boundingBox()).toEqual(
      before,
    );
    await page.keyboard.press("Tab");
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row.locator(":popover-open")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(
      page.locator(".otk-tab [popover],.otk-tab button[popovertarget]"),
    ).toHaveCount(0);
  },
);
test(
  "visual.registered-dialogs-native-dismissal-focus-and-available-actions",
  tags,
  async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    for (
      const selector of [
        ".otk-display-menu > button",
        ".otk-keys-entry",
        ".otk-add-project",
        ".otk-task-new",
        '[aria-label="Edit prompt"]',
      ]
    ) {
      const trigger = page.locator(selector);
      await trigger.click();
      const surface = selector.includes("display")
        ? page.locator(":popover-open")
        : page.locator("dialog[open]");
      await expect(surface).toBeVisible();
      await expect(surface.locator(".otk-surface")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(surface).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Commands", exact: true }))
      .toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.locator("input[name=command-search]").fill("Choose theme");
    await page.locator('[data-command="theme.open"]').click();
    await expect(page.getByRole("dialog", { name: "Theme", exact: true }))
      .toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".otk-project-menu > button").first().click();
    await expect(page.locator(":popover-open")).toBeVisible();
    await page.locator(".otk-inbox-search").click();
    await expect(page.locator(":popover-open")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Commands", exact: true }))
      .toBeVisible();
    await page.keyboard.press("Escape");
  },
);
test(
  "visual.task-form-submission-real-owner-and-more-exact-partition-navigation",
  tags,
  async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    await page.locator(".otk-task-new").click();
    await page.locator("input[name=taskName]").fill("Created Dark");
    await page.locator("dialog[open] button[type=submit]").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    const tasks = await state.product("tasks.list", {
      directory: state.directory,
    });
    expect(tasks.filter((t) => t.name === "Created Dark")).toHaveLength(1);
    const observed = await state.observe<
        { entries: { id: string; directory: string; title: string }[] }
      >(),
      entries = observed.entries.filter((e) => e.directory === state.directory),
      ids = entries.map((e) => e.id);
    await state.product("tasks.sessions", {
      id: tasks.find((t) => t.name === "Created Dark")!.id,
      sessions: ids,
    });
    await state.product("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    await page.setViewportSize({ width: 800, height: 800 });
    await page.goto(state.url + "/#/local/tstv1-otk");
    await page.locator(".otk-folded-crumbs > button").click();
    await expect(
      page.locator(".otk-folded-crumbs [data-overflow-target]").first(),
    ).toBeVisible();
    const visible = await page.locator("[data-crumb]").evaluateAll((els) =>
        els.filter((el) => !el.closest("[hidden]")).map((el) =>
          el.getAttribute("data-crumb")!
        )
      ),
      hidden = await page.locator(".otk-folded-crumbs [data-overflow-target]")
        .evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-overflow-target")!)
        );
    expect(visible.length + hidden.length).toBe(ids.length);
    expect(hidden).toEqual(ids.filter((id) => !visible.includes(id)));
    const target = hidden[0];
    await page.locator(`.otk-folded-crumbs [data-overflow-target="${target}"]`)
      .click();
    await expect(page).toHaveURL(new RegExp("/" + target + "$"));
    await expect(page.locator(`[data-crumb="${target}"]`)).toHaveAttribute(
      "aria-label",
      new RegExp(entries.find((e) => e.id === target)!.title),
    );
  },
);
