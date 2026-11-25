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
  // Isolate cross-checkout work; D57 puts unanswered questions and local work
  // ahead of this particular proof if either is still present.
  await scenario("release", "tstv1-disp-2");
  await scenario("release", "tstv1-disp-0");
  await expect(crumb).toHaveAttribute("data-state", "none");
  await expect(tab).toHaveAttribute("data-state", "working");
  await expect(project).toHaveAttribute("data-state", "working");

  await scenario("release", "tstv1-disp-1");
  await expect(crumb).toHaveAttribute("data-state", "none");
  await expect(tab).toHaveAttribute("data-state", "finished");
  await expect(project).toHaveAttribute("data-state", "finished");
});
