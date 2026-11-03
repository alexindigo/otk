// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  appActions,
  clipboard,
  contextMenu,
  copied,
  dismiss,
  groups,
  menuLabels,
  pick,
  rightClick,
  sessionActions,
} from "../../pages/menus.ts";
test.use({ profile: "contract-menus-inbox" });

test("menus.current-session-omits-noops-background-open-and-task-promotion", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
    sessionID: "tstv1-second",
  });
  await openSession(state, page, "tstv1-otk");
  for (
    const selector of [
      ".otk-user-bubble",
      ".otk-messages",
      '[data-tab="tstv1-otk"]',
      '[data-crumb="tstv1-otk"]',
      '[data-session="tstv1-otk"]',
    ]
  ) {
    await rightClick(page, selector, selector === ".otk-messages");
    expect(await menuLabels(page)).not.toContain("Open");
    expect(await menuLabels(page)).toContain("Pin as task");
    await dismiss(page);
  }
  for (
    const selector of [
      '[data-tab="tstv1-second"]',
      '[data-session="tstv1-second"]',
    ]
  ) {
    await rightClick(page, selector);
    expect(await menuLabels(page)).toContain("Open");
    await dismiss(page);
  }
  await rightClick(page, ".otk-user-bubble");
  expect(await groups(page)).toEqual([["Copy prompt"], sessionActions]);
  await dismiss(page);
  await rightClick(page, ".otk-messages", true);
  await pick(page, "Pin as task");
  await expect(page.locator(".otk-tab[data-kind=task]")).toHaveCount(1);
  const tasks = await state.product("tasks.list", {
    directory: state.directory,
  });
  expect(tasks).toHaveLength(1);
  expect(tasks[0].sessions).toContain("tstv1-otk");
  for (
    const selector of [
      ".otk-user-bubble",
      ".otk-messages",
      '[data-crumb="tstv1-otk"]',
      '[data-session="tstv1-otk"]',
    ]
  ) {
    await rightClick(page, selector, selector === ".otk-messages");
    expect(
      (await menuLabels(page)).filter((label) =>
        ["Open", "Open as task", "Pin as task"].includes(label)
      ),
    ).toEqual([]);
    await dismiss(page);
  }
  await rightClick(page, '[data-session="tstv1-second"]');
  await pick(page, "Open");
  await expect(page).toHaveURL(/\/tstv1-second$/);
  await expect(page.locator('[data-message="second-message"]')).toBeVisible();
  await rightClick(page, '[data-session="tstv1-otk"]');
  expect(await menuLabels(page)).toContain("Open");
  expect(await menuLabels(page)).toContain("Open as task");
  expect(await menuLabels(page)).not.toContain("Pin as task");
  await pick(page, "Open as task");
  await expect(page).toHaveURL(/\/tstv1-otk$/);
  await expect(page.locator(`[data-tab="${tasks[0].id}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await state.product("tasks.list", { directory: state.directory }))
    .toHaveLength(1);
});

test(
  "menus.area-groups-commands-search-focus-clipboard-editor-and-file-picker",
  { tag: ["@menus", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const entries =
      (await state.observe<{ entries: { id: string; directory: string }[] }>())
        .entries;
    for (const entry of [entries[0], entries[3]]) {
      await state.product("projects.visit", {
        directory: entry.directory,
        active: true,
      });
    }
    await state.product("projects.inactive", {
      directory: entries[3].directory,
      inactive: true,
    });
    await openSession(state, page, "tstv1-otk");
    await clipboard(page);
    const projects = [
      "Add project",
      "Show inactive projects",
      "Collapse projects",
    ];
    await rightClick(page, ".otk-inbox-scroll", true);
    expect(await groups(page)).toEqual([projects, appActions]);
    await pick(page, "Show inactive projects");
    await expect(
      page.locator(
        '.otk-inactive-projects [data-project-sessions~="tstv1-luch"]',
      ),
    ).toBeVisible();
    await rightClick(page, ".otk-inbox-scroll", true);
    expect(await groups(page)).toEqual([[
      "Add project",
      "Hide inactive projects",
      "Collapse projects",
    ], appActions]);
    await pick(page, "Hide inactive projects");
    await expect(page.locator(".otk-inactive-projects")).toHaveCount(0);
    await rightClick(
      page,
      '[data-project-sessions~="tstv1-otk"] .otk-project-open',
    );
    expect(await groups(page)).toEqual([["Mark inactive"], projects]);
    await dismiss(page);
    await rightClick(page, ".otk-inbox-scroll", true);
    await pick(page, "Add project");
    await expect(
      page.getByRole("dialog", { name: "Add project", exact: true }).locator(
        "input[name=directory]",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Scanned projects", { exact: true }))
      .toBeAttached();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await rightClick(page, ".otk-inbox-scroll", true);
    await pick(page, "Collapse projects");
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect((await state.product("prefs.get", {})).shellLayout.leftCollapsed)
      .toBe(true);
    await page.locator(".otk-corner-left").click();
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
    const search = page.getByRole("searchbox", {
      name: "Search sessions by title",
      exact: true,
    });
    for (let n = 0; n < 2; n++) {
      await rightClick(page, ".otk-panel-content", true);
      expect(await groups(page)).toEqual([[
        "New session",
        "Find a session",
        "Collapse right panel",
      ], appActions.slice(1)]);
      await pick(page, "Find a session");
      await expect(contextMenu(page)).toHaveCount(0);
      await expect(search).toBeFocused();
    }
    await search.pressSequentially("not-present");
    await expect(page.locator(".otk-session-row")).toHaveCount(0);
    await search.fill("");
    await expect(page.locator(".otk-session-row").first()).toBeVisible();
    await rightClick(page, ".otk-panel-content", true);
    await pick(page, "Collapse right panel");
    await expect(page.locator(".otk-app")).toHaveAttribute(
      "data-right-collapsed",
      "true",
    );
    expect((await state.product("prefs.get", {})).shellLayout.rightCollapsed)
      .toBe(true);
    await page.locator(".otk-corner-right").click();
    await expect(page.locator(".otk-app")).toHaveAttribute(
      "data-right-collapsed",
      "false",
    );
    const before =
      (await state.observe<{ entries: unknown[] }>()).entries.length;
    await rightClick(page, ".otk-panel-content", true);
    await pick(page, "New session");
    await expect(page).not.toHaveURL(/\/tstv1-otk$/);
    await expect(page.locator("textarea[name=prompt]")).toBeVisible();
    const created =
      (await state.observe<{ entries: { id: string }[] }>()).entries;
    expect(created).toHaveLength(before + 1);
    await openSession(state, page, "tstv1-otk");
    await rightClick(page, ".otk-messages", true);
    expect(await groups(page)).toEqual([sessionActions, appActions]);
    await pick(page, "Copy session title");
    await copied(page, "Execution");
    await rightClick(page, ".otk-user-bubble");
    expect(await groups(page)).toEqual([["Copy prompt"], sessionActions]);
    await pick(page, "Copy prompt");
    await copied(page, "Transcript for otk");
    const prompt = page.locator("textarea[name=prompt]");
    await prompt.fill("Keep this prompt");
    await rightClick(page, ".otk-prompt-actions", true);
    expect(await groups(page)).toEqual([
      ["Edit prompt", "Attach files"],
      appActions,
    ]);
    await pick(page, "Edit prompt");
    await expect(page.locator("dialog[open] textarea")).toHaveValue(
      "Keep this prompt",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(prompt).toHaveValue("Keep this prompt");
    await rightClick(page, ".otk-prompt-actions", true);
    const chooser = page.waitForEvent("filechooser");
    await pick(page, "Attach files");
    await (await chooser).setFiles({
      name: "area-attachment.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Area attachment bytes"),
    });
    await expect(
      page.locator('.otk-prompt-chip button[title="area-attachment.txt"]'),
    ).toBeVisible();
    await expect(page.locator(".otk-prompt-chip")).not.toContainText("reading");
    await openSession(state, page, created.at(-1)!.id);
    await rightClick(page, '[data-session="tstv1-otk"]');
    await pick(page, "Open");
    await expect(page).toHaveURL(/\/tstv1-otk$/);
    await expect(page.locator('[data-message="otk-message"]')).toBeVisible();
    await rightClick(page, ".otk-messages", true);
    await pick(page, "Pin as task");
    await expect(page.locator(".otk-tab[data-kind=task]")).toHaveCount(1);
    expect(
      (await state.product("tasks.list", { directory: state.directory })).some(
        (task) => task.sessions.includes("tstv1-otk"),
      ),
    ).toBe(true);
  },
);
