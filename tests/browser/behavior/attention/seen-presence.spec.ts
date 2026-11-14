// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { notificationTest as test } from "../../fixtures/notifications.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { hideNotifications } from "../../pages/notifications.ts";
import { activity } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-inbox" });
test("attention.finish-while-away-is-seen-once-when-the-user-returns", {
  tag: ["@attention", "@sessions", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  // Each session is alone in its project, so project unread is its own.
  const viewed = "tstv1-otk", other = "tstv1-luch";
  const directory = async (id: string) =>
    (await state.product("session.get", { sessionID: id })).directory;
  for (const id of [viewed, other]) {
    await state.product("projects.visit", {
      directory: await directory(id),
      active: true,
    });
  }
  const frames = await wire(page);
  await openSession(state, page, viewed);
  const acknowledged = (id: string) =>
    frames.sent.filter(({ frame }) =>
      frame.method === "sessions.seen" && frame.params?.sessionID === id
    ).map(({ frame }) => frame.params!.terminal);
  const inbox = async () => (await state.product("inbox.get", {})).inbox;
  const project = async (id: string) =>
    page.locator(`[data-project=${JSON.stringify(await directory(id))}]`);
  const viewedProject = await project(viewed),
    otherProject = await project(other);
  await expect.poll(() => acknowledged(viewed)).toEqual([0]);
  for (const row of [viewedProject, otherProject]) {
    await expect(row.locator(".otk-project-name")).toHaveAttribute(
      "data-unread",
      "false",
    );
  }

  // A finish while the window is hidden and unfocused stays unseen.
  const restore = await hideNotifications(page);
  await activity(state, viewed, "hold");
  await activity(state, viewed, "release");
  await expect(viewedProject.locator(".otk-project-name")).toHaveAttribute(
    "data-unread",
    "true",
  );
  await expect(viewedProject).toHaveAttribute("data-rollup", "finished");
  const finish = (await inbox()).finishes[viewed];
  expect(finish).toBeGreaterThan(0);
  expect(acknowledged(viewed)).toEqual([0]);
  expect((await inbox()).seen[viewed] ?? 0).toBeLessThan(finish);

  // Returning to the window is seeing it: one acknowledgement, same token.
  await restore();
  await expect.poll(() => acknowledged(viewed)).toEqual([0, finish]);
  await expect(viewedProject.locator(".otk-project-name")).toHaveAttribute(
    "data-unread",
    "false",
  );
  expect((await inbox()).seen[viewed]).toBe(finish);

  // A finish in a session that is not on screen stays unseen, including
  // across a later presence change.
  await activity(state, other, "hold");
  await activity(state, other, "release");
  await expect(otherProject.locator(".otk-project-name")).toHaveAttribute(
    "data-unread",
    "true",
  );
  await (await hideNotifications(page))();
  await expect(otherProject.locator(".otk-project-name")).toHaveAttribute(
    "data-unread",
    "true",
  );
  await expect(otherProject).toHaveAttribute("data-rollup", "finished");
  expect(acknowledged(other)).toEqual([]);
  expect(acknowledged(viewed)).toEqual([0, finish]);
  expect((await inbox()).seen[other] ?? 0).toBe(0);
});
