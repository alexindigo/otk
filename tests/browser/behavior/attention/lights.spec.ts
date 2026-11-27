// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { scenario } from "../../pages/attention.ts";

test.use({ profile: "contract-attention-lights" });
test(
  "attention.project-task-lamps-keep-all-mandatory-activity-visible-through-collapse-reload",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const { entries } = await state.observe<
      { entries: { id: string; directory: string }[] }
    >();
    const directory = entries[0].directory;
    for (const entry of entries.slice(0, 4)) {
      await state.product("projects.visit", {
        directory: entry.directory,
        active: true,
      });
    }
    const task = await state.product("tasks.create", {
      directory,
      name: "Review",
      sessions: ["tstv1-otk", "tstv1-running", "tstv1-done"],
    });
    for (
      const [id, name] of [["tstv1-idle-tab", "Quiet"], [
        "tstv1-green-tab",
        "Working",
      ], ["tstv1-amber-tab", "Finished"]]
    ) await state.product("tasks.create", { directory, name, sessions: [id] });
    await state.product("prefs.set", { key: "notify.toast", value: false });
    await openSession(state, page, "tstv1-otk");
    await expect(page.locator(".otk-server-status .otk-connection-light"))
      .toHaveAttribute("data-connection-state", "connected");
    await expect(page.locator(".otk-server-status .otk-status-light"))
      .toHaveCount(0);
    for (
      const id of [
        "tstv1-running",
        "tstv1-green-tab",
        "tstv1-done",
        "tstv1-amber-tab",
        "tstv1-atmosphera",
        "tstv1-globnotes",
      ]
    ) await scenario(state, "hold", id);
    for (const id of ["tstv1-done", "tstv1-amber-tab", "tstv1-globnotes"]) {
      await scenario(state, "release", id);
    }
    await scenario(state, "freeze", "tstv1-blocked");
    const project = page.locator(`[data-project="${directory}"]`),
      tab = page.locator(`[data-tab="${task.id}"]`);
    await expect(tab.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "finished", // D78: an unseen finish wins over a running sibling.
    );
    await expect(project.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "blocked",
    );
    for (const state of ["blocked", "finished", "working", "none"]) {
      await expect(
        page.locator(`.otk-inbox-scroll .otk-status-light[data-state=${state}]`)
          .first(),
      ).toBeVisible();
      const lamp = page.locator(
        `.otk-project-tabs [role=tab] .otk-status-light[data-state=${state}]`,
      ).first();
      await expect(lamp).toBeVisible();
      await expect(lamp).toBeInViewport({ ratio: 1 });
    }
    await state.product("tasks.addSession", {
      id: task.id,
      sessionID: "tstv1-blocked",
    });
    await expect(tab.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "blocked",
    );
    await scenario(state, "release", "tstv1-blocked");
    const inspect = async () => {
      for (const consumer of [tab, project]) {
        const lamp = consumer.locator(".otk-status-light");
        await expect(lamp).toHaveAttribute("data-state", "finished");
        await expect(lamp).toBeVisible();
        await expect(lamp).toBeInViewport({ ratio: 1 });
      }
    };
    await inspect();
    await page.reload();
    await inspect();
    await page.getByRole("button", { name: "Collapse projects", exact: true })
      .click();
    await state.product("layout.patch", { rightCollapsed: true });
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator(".otk-right-panel")).toBeHidden();
    await inspect();
    await page.reload();
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator(".otk-right-panel")).toBeHidden();
    await inspect();
    await expect(page.locator(".otk-server-status .otk-connection-light"))
      .toHaveAttribute("data-connection-state", "connected");
    await scenario(state, "freeze");
    await expect(page.locator(".otk-server-status .otk-connection-light"))
      .toHaveAttribute("data-connection-state", "reconnecting");
    await scenario(state, "release");
    await page.locator(".otk-settings-entry").click();
    const connection = page.locator(".otk-settings .otk-connection-light");
    await expect(connection).toHaveAttribute(
      "data-connection-state",
      "connected",
    );
    for (
      const [action, status] of [["hold", "connecting"], [
        "freeze",
        "reconnecting",
      ], ["release", "connected"]] as const
    ) {
      await scenario(state, action);
      await expect(connection).toHaveAttribute("data-connection-state", status);
    }
  },
);

test("attention.unseen-finished-task-outweighs-working-task-until-viewed", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const running = "tstv1-running", finished = "tstv1-done";
  const workingTask = await state.product("tasks.create", {
    directory: state.directory,
    name: "Working task",
    sessions: [running],
  });
  const finishedTask = await state.product("tasks.create", {
    directory: state.directory,
    name: "Finished task",
    sessions: [finished],
  });
  await openSession(state, page, "tstv1-otk");
  await scenario(state, "hold", running);
  const project = page.locator(
    `[data-project="${state.directory}"] .otk-status-light`,
  );
  const workingLamp = page.locator(
    `[data-tab="${workingTask.id}"] .otk-status-light`,
  );
  const finishedTab = page.locator(`[data-tab="${finishedTask.id}"]`);
  const finishedLamp = finishedTab.locator(".otk-status-light");
  await expect(project).toHaveAttribute("data-state", "working");
  await scenario(state, "hold", finished);
  await scenario(state, "release", finished);
  // D78: the unseen finish must be visible at both levels, even during work.
  await expect(workingLamp).toHaveAttribute("data-state", "working");
  await expect(finishedLamp).toHaveAttribute("data-state", "finished");
  await expect(project).toHaveAttribute("data-state", "finished");
  await expect(finishedLamp).toBeVisible();
  await expect(project).toBeVisible();

  await finishedTab.click();
  await expect(page).toHaveURL(new RegExp(`${finished}$`));
  await expect(finishedLamp).toHaveAttribute("data-state", "none");
  await expect(workingLamp).toHaveAttribute("data-state", "working");
  await expect(project).toHaveAttribute("data-state", "working");
});
