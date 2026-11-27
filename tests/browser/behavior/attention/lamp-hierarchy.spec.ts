// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-sessions-hierarchy" });

test("attention.lamp-hierarchy-session-own-task-subtree-project-tasks", {
  tag: ["@attention", "@sessions", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const main = "tstv1-otk";
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: "One task across checkouts",
    sessions: [main],
  });
  const scenario = (action: "hold" | "release", sessionID: string) =>
    state.controller.call("scenario", {
      lease: state.lease.lease,
      action,
      sessionID,
    });
  await scenario("release", main);
  await scenario("release", "tstv1-blocked");
  await openSession(state, page, main);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
    target: "helper-dispositions",
  });

  const lamp = (selector: string) =>
    page.locator(`${selector} .otk-status-light`);
  const crumb = lamp(`[data-crumb=${main}]`);
  const tab = lamp(`[data-tab="${task.id}"]`);
  const project = lamp(`[data-project="${state.directory}"]`);
  await expect(crumb).toHaveAttribute("data-state", "none");
  await expect(tab).toHaveAttribute("data-state", "blocked");
  await expect(project).toHaveAttribute("data-state", "blocked");
  // D78: acknowledge the finished local work so the cross-checkout helper
  // is the only remaining activity in the task and project.
  await scenario("release", "tstv1-disp-2");
  await scenario("release", "tstv1-disp-0");
  for (const sessionID of [main, "tstv1-finished", "tstv1-blocked"]) {
    await state.product("sessions.acknowledge", {
      scope: "subtree",
      sessionID,
    });
  }
  await expect(crumb).toHaveAttribute("data-state", "none");
  await expect(tab).toHaveAttribute("data-state", "working");
  await expect(project).toHaveAttribute("data-state", "working");

  await scenario("release", "tstv1-disp-1");
  await expect(crumb).toHaveAttribute("data-state", "none");
  await expect(tab).toHaveAttribute("data-state", "finished");
  await expect(project).toHaveAttribute("data-state", "finished");
});
