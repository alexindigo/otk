// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test as ordinary } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  activity,
  contextMenu,
  sessionContext,
  visibleOnScreen,
} from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-close" });
test("sessions.close-surfaces-membership-and-mandatory-phantom", {
  tag: ["@sessions", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  for (
    const selector of [
      '[data-tab="tstv1-otk"]',
      '[data-crumb="tstv1-otk"]',
      '[data-session="tstv1-otk"]',
      ".otk-user-bubble",
    ]
  ) {
    await sessionContext(page, selector);
    await expect(
      page.locator(`${contextMenu} [data-context-command="session.close"]`),
    ).toHaveText("Close session");
    await page.keyboard.press("Escape");
  }
  await sessionContext(page, '[data-tab="tstv1-otk"]', "session.close");
  await expect(page).toHaveURL(/#project\//);
  await expect(page.locator('[data-tab="tstv1-otk"]')).toHaveCount(0);
  await expect(page.locator('[data-session="tstv1-otk"]')).toBeVisible();
  await page.locator('[data-session="tstv1-otk"]').click();
  await expect(page.locator('[data-tab="tstv1-otk"]')).toBeVisible();
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: "Delivery",
    sessions: ["tstv1-otk", "tstv1-second"],
  });
  await expect(page.locator(`[data-tab="${task.id}"]`)).toBeVisible();
  await page.locator('[data-session="tstv1-child"]').click();
  await expect(page).toHaveURL(/tstv1-otk\/tstv1-child$/);
  await expect(page.locator('[data-crumb="tstv1-child"]')).toHaveCount(0);
  await sessionContext(page, '[data-session="tstv1-child"]', "session.close");
  await expect(page).toHaveURL(/tstv1-otk$/);
  await expect(page.locator('[data-crumb="tstv1-child"]')).toHaveCount(0);
  await expect(page.locator('[data-session="tstv1-child"]')).toBeVisible();
  expect(
    (await state.product("tasks.list", { directory: state.directory }))[0]
      .sessions,
  ).toEqual(["tstv1-otk", "tstv1-second"]);
  await sessionContext(page, '[data-session="tstv1-second"]', "session.close");
  await expect(page.locator('[data-crumb="tstv1-second"]')).toHaveCount(0);
  await expect(page.locator('[data-session="tstv1-second"]')).toBeVisible();
  expect(
    (await state.product("tasks.list", { directory: state.directory }))[0]
      .sessions,
  ).toEqual(["tstv1-otk"]);
  await expect(page).toHaveURL(/tstv1-otk$/);
  await activity(state, "tstv1-otk", "hold");
  await expect(page.locator(`[data-tab="${task.id}"] .otk-status-light`))
    .toHaveAttribute("data-state", "working");
  page.once("dialog", (d) => d.dismiss());
  await sessionContext(page, ".otk-user-bubble", "session.close");
  expect(
    (await state.product("tasks.list", { directory: state.directory }))[0]
      .sessions,
  ).toEqual(["tstv1-otk"]);
  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    void d.accept();
  });
  await sessionContext(page, ".otk-user-bubble", "session.close");
  // There is no idle state; the phantom lasts while evidence or an unseen finish does.
  expect(message).toContain(
    "phantom tab while it has known activity or an unseen finish",
  );
  await expect(page).toHaveURL(/#project\//);
  await visibleOnScreen(page.locator('[data-tab="tstv1-otk"]'));
  expect(
    (await state.product("tasks.list", { directory: state.directory }))[0]
      .sessions,
  ).toEqual([]);
  await state.product("layout.patch", { rightCollapsed: true });
  await page.reload();
  await visibleOnScreen(page.locator('[data-tab="tstv1-otk"]'));
  await expect(page.locator(".otk-right-panel")).toBeHidden();
  await activity(state, "tstv1-otk", "release");
  await expect(page.locator('[data-tab="tstv1-otk"] .otk-status-light'))
    .toHaveAttribute("data-state", "finished");
  await state.product("sessions.seen", {
    sessionID: "tstv1-otk",
    terminal: (await state.product("sessions.finishes", {}))["tstv1-otk"] ?? 0,
  });
  await expect(page.locator('[data-tab="tstv1-otk"]')).toHaveCount(0);
  await state.product("layout.patch", { rightCollapsed: false });
  expect((await state.product("session.get", { sessionID: "tstv1-otk" })).id)
    .toBe("tstv1-otk");
  await page.locator('[data-session="tstv1-otk"]').click();
  await expect(page).toHaveURL(/tstv1-otk$/);
  await visibleOnScreen(page.locator('[data-tab="tstv1-otk"]'));
});

ordinary("sessions.native-close-preserves-record-and-reopens", {
  tag: ["@sessions"],
}, async ({ state, page }) => {
  const s = await state.native<{ id: string; nativeID: string }>(
    "/session",
    "POST",
    { title: "Retained in opencode" },
  );
  await openSession(state, page, s.id);
  await sessionContext(page, `[data-tab="${s.id}"]`, "session.close");
  await expect(page.locator(`[data-tab="${s.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-session="${s.id}"]`)).toBeVisible();
  expect((await state.native<{ id: string }>(`/session/${s.id}`)).id).toBe(
    s.nativeID,
  );
  await page.locator(`[data-session="${s.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${s.id}$`));
  await expect(page.locator(`[data-tab="${s.id}"]`)).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.locator('[data-command="session.close"]').click();
  await expect(page.locator(`[data-tab="${s.id}"]`)).toHaveCount(0);
  await expect(page).toHaveURL(/#project\//);
  expect((await state.native<{ id: string }>(`/session/${s.id}`)).id).toBe(
    s.nativeID,
  );
});
