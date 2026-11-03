// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";

test.use({ profile: "contract-sessions-membership" });
test("sessions.create-in-task-retains-concurrent-authoritative-membership", {
  tag: ["@sessions", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: "Shared task",
    sessions: ["tstv1-otk", "tstv1-kept"],
  });
  const frames = await wire(page);
  await page.goto(state.url + "/#/local/tstv1-otk");
  await expect(page.locator("[data-crumb=tstv1-kept]")).toBeVisible();
  await expect(page.locator(".otk-prompt")).toBeVisible();
  frames.hold((frame) => ["inbox.snapshot", "inbox.patch"].includes(frame.t));
  await page.locator(".otk-new-session").click();
  await expect.poll(async () =>
    (await state.observe<{ creates: number }>()).creates
  ).toBe(1);
  await state.product("tasks.sessions", {
    id: task.id,
    sessions: ["tstv1-kept", "tstv1-added"],
  });
  await expect.poll(() => frames.held.length).toBeGreaterThan(0);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "release",
  });
  await expect(page).toHaveURL(/#\/local\/(?!tstv1-otk$)tstv1-/);
  await expect(page.locator(".otk-prompt")).toBeVisible();
  const created = new URL(page.url()).hash.split("/").at(-1)!;
  expect(
    (await state.product("tasks.list", { directory: state.directory }))[0]
      .sessions,
  ).toEqual(["tstv1-kept", "tstv1-added", created]);
  frames.release();
  await page.reload();
  await expect(page.locator("[data-crumb=tstv1-kept]")).toBeVisible();
  await expect(page.locator("[data-crumb=tstv1-added]")).toBeVisible();
  await expect(page.locator("[data-crumb=tstv1-otk]")).toHaveCount(0);
  await expect(page.locator("[data-crumb]")).toHaveCount(3);
});
