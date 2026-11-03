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
      "finished",
    );
    await expect(project.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "blocked",
    );
    for (const state of ["blocked", "finished", "working", "idle"]) {
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
