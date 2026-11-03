// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  clipboard,
  contextMenu,
  copied,
  dismiss,
  keyboardItem,
  menuLabels,
  panelActions,
  pick,
  rightClick,
} from "../../pages/menus.ts";
test.use({ profile: "contract-menus-inbox" });

test("menus.captured-session-task-and-project-effects", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await state.product("projects.visit", {
    directory: state.directory,
    active: true,
  });
  await openSession(state, page, "tstv1-otk");
  await clipboard(page);
  const spare = await state.product("tasks.create", {
    directory: state.directory,
    name: "Review",
  });
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: "Delivery",
  });
  await expect(page.locator(`[data-tab="${task.id}"]`)).toBeVisible();
  const expected = [
    "Pin as task",
    "Add to task: Review",
    "Add to task: Delivery",
    "Copy session title",
    "Close session",
  ];
  for (
    const [name, selector] of [["tab", '[data-tab="tstv1-otk"]'], [
      "chip",
      '[data-crumb="tstv1-otk"]',
    ], ["row", '[data-session="tstv1-otk"]']]
  ) {
    await rightClick(page, selector);
    expect(await menuLabels(page)).toEqual(
      name === "row" ? [...expected, ...panelActions] : expected,
    );
    expect(
      await contextMenu(page).getByRole("menuitem").filter({
        hasText: "Add to task:",
      }).evaluateAll((items) =>
        items.map((el) => el.getAttribute("data-context-command"))
      ),
    ).toEqual(["task.add", "task.add"]);
    await expect(contextMenu(page)).toBeFocused();
    await expect(contextMenu(page)).toHaveCSS("outline-style", "none");
    await pick(page, "Copy session title");
    await copied(page, "Execution");
    await expect(contextMenu(page)).toHaveCount(0);
  }
  await page.locator('[data-tab="tstv1-otk"]').focus();
  for (const key of ["ContextMenu", "Shift+F10"]) {
    await page.keyboard.press(key);
    await expect(
      contextMenu(page).getByRole("menuitem", {
        name: "Pin as task",
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      contextMenu(page).getByRole("menuitem", {
        name: "Close session",
        exact: true,
      }),
    ).toBeFocused();
    await dismiss(page);
    await expect(page.locator('[data-tab="tstv1-otk"]')).toBeFocused();
  }
  await rightClick(page, '[data-session="tstv1-second"]');
  await pick(page, "Open");
  await expect(page).toHaveURL(/\/tstv1-second$/);
  await expect(page.locator('[data-message="second-message"]')).toBeVisible();
  await rightClick(page, '[data-session="tstv1-otk"]');
  await pick(page, "Add to task: Delivery");
  await expect.poll(() =>
    page.locator('[data-session="tstv1-otk"]').evaluate((row) => {
      const items = Array.from(
        document.querySelectorAll(
          ".otk-project-session-tree [data-session-group],.otk-project-session-tree [data-session]",
        ),
      );
      return items.slice(0, items.indexOf(row)).filter((el) =>
        el.hasAttribute("data-session-group")
      ).at(-1)?.getAttribute("data-session-group");
    })
  ).toBe(task.id);
  await rightClick(page, '[data-session="tstv1-otk"]');
  expect(await menuLabels(page)).toEqual([
    "Open",
    "Open as task",
    "Add to task: Review",
    "Copy session title",
    "Close session",
    ...panelActions,
  ]);
  await pick(page, "Open as task");
  await expect(page).toHaveURL(/\/tstv1-otk$/);
  await expect(page.locator(`[data-tab="${task.id}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await rightClick(page, '[data-session="tstv1-second"]');
  await pick(page, "Open");
  await expect(page.locator('[data-crumb="tstv1-second"]')).toBeVisible();
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "freeze",
  });
  await expect(page.locator(".otk-server-status")).toHaveAttribute(
    "aria-label",
    /agent service reconnecting/,
  );
  await rightClick(page, '[data-crumb="tstv1-second"]');
  expect(await menuLabels(page)).toContain("Pin as task");
  await pick(page, "Pin as task");
  await expect(page.locator(".otk-tab[data-kind=task]")).toHaveCount(3);
  expect(
    (await state.product("tasks.list", { directory: state.directory })).some(
      (t) => t.name === "Second session" && t.sessions.includes("tstv1-second"),
    ),
  ).toBe(true);
  await state.product("tasks.close", { id: spare.id });
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "thaw",
  });
  await expect(page.locator(".otk-server-status")).toHaveAttribute(
    "aria-label",
    /agent service connected/,
  );
  await rightClick(page, `[data-tab="${task.id}"]`);
  expect(await menuLabels(page)).toEqual(["Rename task", "Close task"]);
  await expect(contextMenu(page).getByRole("separator")).toHaveCount(1);
  await pick(page, "Rename task");
  await page.locator("input[name=taskName]").fill("Delivered");
  await page.locator("dialog button[type=submit]").click();
  await expect(page.locator(`[data-tab="${task.id}"]`)).toHaveAttribute(
    "aria-label",
    "Delivered",
  );
  expect(
    (await state.product("tasks.list", { directory: state.directory })).find(
      (t) => t.id === task.id,
    )?.name,
  ).toBe("Delivered");
  await rightClick(page, `[data-tab="${task.id}"]`);
  await pick(page, "Close task");
  await expect(page.locator(`[data-tab="${task.id}"]`)).toHaveCount(0);
  expect(
    (await state.product("tasks.list", { directory: state.directory })).some(
      (t) => t.id === task.id,
    ),
  ).toBe(false);
  await expect(page).toHaveURL(/\/tstv1-second$/);
  const project = '[data-project-sessions~="tstv1-otk"] .otk-project-open';
  await rightClick(page, project);
  expect(await menuLabels(page)).toEqual([
    "Mark inactive",
    "Add project",
    "Collapse projects",
  ]);
  await pick(page, "Mark inactive");
  await page.locator(".otk-inactive-toggle").click();
  await expect(page.locator('[data-project-sessions~="tstv1-otk"]'))
    .toHaveAttribute("data-inactive", "true");
  await rightClick(page, project);
  expect(await menuLabels(page)).toEqual([
    "Mark active",
    "Add project",
    "Hide inactive projects",
    "Collapse projects",
  ]);
  await pick(page, "Mark active");
  await expect(page.locator('[data-project-sessions~="tstv1-otk"]'))
    .toHaveAttribute("data-inactive", "false");
});

test("menus.stale-task-and-session-commands-preserve-captured-identities", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  await clipboard(page);
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: "Captured task",
  });
  await expect(page.locator(`[data-tab="${task.id}"]`)).toBeVisible();
  await page.locator(".otk-user-bubble .otk-text").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await rightClick(page, `[data-tab="${task.id}"]`);
  expect(await menuLabels(page)).toEqual(["Rename task", "Close task"]);
  await page.evaluate(() =>
    location.hash = location.hash.slice(0, location.hash.lastIndexOf("/") + 1) +
      "tstv1-atmosphera"
  );
  await expect(page).toHaveURL(/\/tstv1-atmosphera$/);
  await expect(contextMenu(page)).toHaveCount(0);
  expect(
    (await state.product("tasks.list", { directory: state.directory })).some(
      (value) => value.id === task.id,
    ),
  ).toBe(true);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.evaluate(() =>
    location.hash = location.hash.slice(0, location.hash.lastIndexOf("/") + 1) +
      "tstv1-otk"
  );
  await expect(page).toHaveURL(/\/tstv1-otk$/);
  await rightClick(page, '[data-tab="tstv1-otk"]');
  await page.evaluate(() =>
    location.hash = location.hash.slice(0, location.hash.lastIndexOf("/") + 1) +
      "tstv1-atmosphera"
  );
  await expect(page).toHaveURL(/\/tstv1-atmosphera$/);
  await pick(page, "Copy session title");
  await copied(page, "Execution");
  await expect(page).toHaveURL(/\/tstv1-atmosphera$/);
});

test("menus.shared-menu-pointer-keyboard-focus-and-selection-isolation", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: "Compact menus",
  });
  const ids = [
    "tstv1-otk",
    ...Array.from({ length: 9 }, (_, n) => `tstv1-r2-session-${n + 1}`),
  ];
  await state.product("tasks.sessions", { id: task.id, sessions: ids });
  await page.locator(`[data-tab="${task.id}"]`).click();
  await expect(page.locator(".otk-folded-crumbs > button")).toBeVisible();
  await page.locator('[data-crumb="tstv1-otk"]').click();
  await rightClick(page, '[data-crumb="tstv1-otk"]');
  expect(await menuLabels(page)).toContain("Copy session title");
  await expect(contextMenu(page)).toBeFocused();
  await expect(contextMenu(page)).toHaveCSS("outline-style", "none");
  await page.keyboard.press("ArrowDown");
  await keyboardItem(contextMenu(page).getByRole("menuitem").first());
  await dismiss(page);
  for (const key of ["ContextMenu", "Shift+F10"]) {
    await page.keyboard.press(key);
    await keyboardItem(contextMenu(page).getByRole("menuitem").first());
    await dismiss(page);
  }
  await page.locator(".otk-user-bubble").evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  });
  await rightClick(page, `[data-tab="${task.id}"]`);
  expect(await menuLabels(page)).not.toContain("Copy");
  await dismiss(page);
  expect(await page.evaluate(() => !!getSelection()!.toString())).toBe(true);
  for (
    const [trigger, menu, arrow, last] of [
      [
        '[data-project-sessions~="tstv1-otk"] .otk-project-menu > button',
        ".otk-project-menu :popover-open [role=menu]",
        "ArrowDown",
        false,
      ],
      [
        ".otk-folded-crumbs > button",
        ".otk-folded-crumbs :popover-open [role=menu]",
        "ArrowUp",
        true,
      ],
    ] as const
  ) {
    await page.locator(trigger).click();
    const panel = page.locator(menu);
    await expect(panel).toBeFocused();
    await expect(panel).toHaveCSS("outline-style", "none");
    await page.keyboard.press(arrow);
    await keyboardItem(panel.getByRole("menuitem").nth(last ? -1 : 0));
    await page.keyboard.press("Escape");
    await expect(page.locator(":popover-open")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await keyboardItem(panel.getByRole("menuitem").first());
    await page.keyboard.press("Escape");
    await expect(page.locator(":popover-open")).toHaveCount(0);
  }
});
