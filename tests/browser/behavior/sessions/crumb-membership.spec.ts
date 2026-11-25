// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";
import { activity, contextMenu, sessionContext } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-tabs" });
test(
  "sessions.crumb-navigation-preserves-membership-across-tasks-and-refresh",
  {
    tag: ["@sessions", "@contracts", "@isolated"],
  },
  async ({ isolatedState: state, page }) => {
    const root = "tstv1-otk", child = "tstv1-helper";
    const parentTask = await state.product("tasks.create", {
      directory: state.directory,
      name: "Parent task",
      sessions: [root],
    });
    const childTask = await state.product("tasks.create", {
      directory: state.directory,
      name: "Child task",
      sessions: [child],
    });
    await activity(state, child, "hold");
    const frames = await wire(page);
    await state.product("layout.patch", {
      rightCollapsed: false,
      rightView: "sessions",
    });
    await page.goto(`${state.url}/#/local/${root}/${child}`);
    await expect(page.locator(`[data-tab="${childTask.id}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const membership = async () =>
      (await state.product("tasks.list", { directory: state.directory }))
        .map(({ id, sessions }) => ({ id, sessions })).sort((a, b) =>
          a.id.localeCompare(b.id)
        );
    const before = await membership();
    const start = frames.sent.length;
    await page.locator(`[data-crumb="${root}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${root}$`));
    await expect(page.locator(`[data-tab="${parentTask.id}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // A foreign ancestor must not be selected into the task captured before routing.
    await expect(page.locator(".otk-project-tabs [role=alert]")).toHaveCount(0);
    expect(await membership()).toEqual(before);
    await expect(
      page.locator(
        `[role=group][aria-label="Parent task"] [data-session="${root}"]`,
      ),
    ).toBeVisible();
    await expect(
      page.locator(
        `[role=group][aria-label="Child task"] [data-session="${child}"]`,
      ),
    ).toBeVisible();

    // Keep a genuine list replacement pending while repeated route intents arrive.
    frames.hold((_frame, request) => request?.method === "sessions.list");
    await state.product("tasks.rename", {
      id: childTask.id,
      name: "Child task refreshed",
    });
    await expect.poll(() => frames.held.length).toBeGreaterThan(0);
    for (let n = 0; n < 3; n++) {
      await page.locator(`[data-crumb="${child}"]`).click();
      await expect(page.locator(`[data-tab="${childTask.id}"]`))
        .toHaveAttribute("aria-selected", "true");
      await page.locator(`[data-crumb="${root}"]`).click();
      await expect(page.locator(`[data-tab="${parentTask.id}"]`))
        .toHaveAttribute("aria-selected", "true");
      expect(await membership()).toEqual(before);
      await expect(
        page.locator(
          `[role=group][aria-label="Child task refreshed"] [data-session="${child}"]`,
        ),
      ).toBeVisible();
    }
    frames.release();
    await expect(page.locator(".otk-project-tabs [role=alert]")).toHaveCount(0);
    expect(
      frames.sent.slice(start).filter(({ frame }) =>
        frame.method?.startsWith("tasks.") && frame.method !== "tasks.list"
      ),
    ).toEqual([]);
    expect(await membership()).toEqual(before);

    // Intentional edits still use the membership owner, never a navigation default.
    page.once("dialog", (dialog) => dialog.accept());
    await sessionContext(
      page,
      `[data-session="${child}"]`,
      "session.close",
    );
    await expect.poll(membership).toEqual(
      before.map((task) => ({
        ...task,
        sessions: task.id === childTask.id ? [] : task.sessions,
      })),
    );
    await sessionContext(page, `[data-session="${child}"]`);
    await page.locator(contextMenu).getByRole("menuitem", {
      name: "Add to task: Parent task",
      exact: true,
    }).click();
    await expect.poll(membership).toEqual(
      before.map((task) => ({
        ...task,
        sessions: task.id === parentTask.id ? [root, child] : [],
      })),
    );
    await page.reload();
    await page.locator(`[data-session="${child}"]`).click();
    await expect(page.locator(`[data-tab="${parentTask.id}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  },
);
