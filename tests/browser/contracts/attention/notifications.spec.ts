// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { notificationTest as test } from "../../fixtures/notifications.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  closeSettings,
  reply,
  seed,
  settings,
  tool,
} from "../../pages/attention.ts";
import {
  badge,
  focusNotifications,
  hideNotifications,
  instrumentNotifications,
  notes,
  toast,
} from "../../pages/notifications.ts";
import type { TestState } from "../../fixtures/test-state.ts";

async function finish(
  state: TestState,
  id: string,
  text = "Background completed",
) {
  await state.queue([text]);
  await state.product("session.prompt", {
    sessionID: id,
    mode: "normal",
    parts: [{ kind: "text", text: "Run notification completion" }],
  });
}
test.use({ profile: "contract-attention-native" });
test(
  "attention.notification-real-granted-tag-replacement-default-action-focus-retraction",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const a = await seed(state, "Open A"),
      b = await seed(state, "Background B"),
      c = await seed(state, "Background C");
    await instrumentNotifications(page);
    await page.context().grantPermissions(["notifications"], {
      origin: state.url,
    });
    await openSession(state, page, a.id);
    await focusNotifications(page);
    await settings(page);
    await page.locator('input[name="notify.os"]').click();
    await expect(page.locator('input[name="notify.os"]')).toBeChecked();
    await expect.poll(() => notes(page, "permissionRequests")).toBe(1);
    await closeSettings(page);
    await page.locator("textarea[name=prompt]").fill("Keep OS draft");
    const restore = await hideNotifications(page);
    await finish(state, b.id);
    await expect.poll(() => notes(page, "notes.length")).toBe(1);
    await badge(page, 1);
    await finish(state, b.id, "Replacement completed");
    await expect.poll(() => notes(page, "notes.length===2&&notes[0].closed"))
      .toBe(true);
    expect(await notes(page, "notes.map(n=>n.options.tag)")).toEqual([
      `local/${b.id}`,
      `local/${b.id}`,
    ]);
    await badge(page, 1);
    await finish(state, c.id);
    await expect.poll(() => notes(page, "notes.length")).toBe(3);
    await expect(page.locator(".otk-toast")).toHaveCount(0);
    await badge(page, 2);
    await restore();
    await expect.poll(() => notes(page, "notes.every(n=>n.closed)")).toBe(true);
    await notes(
      page,
      "notes[1].instance.dispatchEvent(new Event('click',{cancelable:true}))",
    );
    await expect(page).toHaveURL(new RegExp(`${b.id}$`));
    await badge(page, 1);
    await openSession(state, page, a.id);
    await expect(page.locator("textarea[name=prompt]")).toHaveValue(
      "Keep OS draft",
    );
    await openSession(state, page, b.id);
    await reply(page, b.id, "Replacement completed");
    await expect.poll(() => notes(page, "notes.every(n=>n.closed)")).toBe(true);
    await badge(page, 1);
    await openSession(state, page, c.id);
    await badge(page, 0);
  },
);
test(
  "attention.notification-denied-permission-persists-blocked-and-hidden-toast-fallback",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const a = await seed(state, "Open A"),
      b = await seed(state, "Denied background");
    await instrumentNotifications(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Browser.setPermission", {
      origin: state.url,
      permission: { name: "notifications" },
      setting: "denied",
    });
    await cdp.detach();
    await openSession(state, page, a.id);
    await focusNotifications(page);
    await settings(page);
    await page.locator('input[name="notify.os"]').click();
    await expect.poll(() => notes(page, "permissionRequests")).toBe(1);
    await expect(page.locator('input[name="notify.os"]')).toBeChecked();
    await expect(page.locator(".otk-notification-browser")).toContainText(
      "Blocked by browser",
    );
    await page.reload();
    await focusNotifications(page);
    await settings(page);
    await expect(page.locator('input[name="notify.os"]')).toBeChecked();
    await expect(page.locator(".otk-notification-browser")).toContainText(
      "Blocked by browser",
    );
    await closeSettings(page);
    const restore = await hideNotifications(page);
    await finish(state, b.id);
    const note = page.locator(toast(b.id));
    await expect(note).toContainText("Session done");
    expect(await notes(page, "notes.length")).toBe(0);
    await restore();
    await note.locator(".otk-toast-message").click();
    await expect(note).toHaveCount(0);
    await badge(page, 1);
    await openSession(state, page, b.id);
    await badge(page, 0);
  },
);
test("attention.notification-unavailable-real-constructor-falls-back-in-page", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const a = await seed(state, "Open A"),
    b = await seed(state, "Unavailable background");
  await instrumentNotifications(page, true);
  await page.context().grantPermissions(["notifications"], {
    origin: state.url,
  });
  await openSession(state, page, a.id);
  await focusNotifications(page);
  await settings(page);
  await page.locator('input[name="notify.os"]').click();
  await expect(page.locator('input[name="notify.os"]')).toBeChecked();
  await closeSettings(page);
  const restore = await hideNotifications(page);
  await finish(state, b.id);
  await expect(page.locator(toast(b.id))).toBeVisible();
  await restore();
  await settings(page);
  await expect(page.locator(".otk-notification-browser")).toContainText(
    "unavailable",
  );
});
test(
  "attention.notification-real-web-audio-gesture-graphs-frequencies-analyser-and-reload",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const a = await seed(state, "Open A"),
      b = await seed(state, "Sound background");
    await instrumentNotifications(page);
    await openSession(state, page, a.id);
    await focusNotifications(page);
    expect(await notes(page, "contexts.length")).toBe(0);
    await settings(page);
    await page.locator('input[name="notify.sound"]').click();
    await expect(page.locator('input[name="notify.sound"]')).toBeChecked();
    await closeSettings(page);
    await expect.poll(() =>
      notes(page, "contexts.length===1&&contexts[0].context.state==='running'")
    ).toBe(true);
    await finish(state, b.id);
    await expect.poll(() =>
      notes(page, "audio.length===2&&audio.every(n=>n.peaks.length>0)")
    ).toBe(true);
    expect(await notes(page, "audio.map(n=>n.frequency)")).toEqual([660, 880]);
    await tool(state, "bash", {
      command: "echo audio-input",
      description: "Audio input",
    });
    await state.product("session.prompt", {
      sessionID: b.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Input tone probe" }],
    });
    await expect.poll(() =>
      notes(page, "audio.length===5&&audio.every(n=>n.peaks.length>0)")
    ).toBe(true);
    expect(await notes(page, "audio.slice(2).map(n=>n.frequency)")).toEqual([
      880,
      660,
      880,
    ]);
    expect(
      await notes(
        page,
        "contexts.every(n=>n.gesture)&&audio.every(n=>n.state==='running'&&n.peaks.some(hz=>Math.abs(hz-n.frequency)<30))",
      ),
    ).toBe(true);
    // Join the real blocked tool before teardown so no scripted response is dropped.
    const pending = await state.product("permission.list", { sessionID: b.id });
    await state.product("permission.reply", {
      sessionID: b.id,
      requestID: pending[0].id,
      reply: "reject",
    });
    await page.reload();
    await focusNotifications(page);
    await settings(page);
    await expect(page.locator('input[name="notify.sound"]')).toBeChecked();
  },
);
