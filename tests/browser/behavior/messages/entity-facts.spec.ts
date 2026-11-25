// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import { prompt as composerPrompt } from "../../pages/composer.ts";

test.use({ profile: "messages-tools" });
test("messages.historical-reply-facts-keep-scope-while-session-works", {
  tag: ["@messages", "@sessions", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  test.setTimeout(120000);
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Scoped reply facts",
  });
  await openSession(state, page, session.id);
  await state.queue(["First historical reply."]);
  await prompt(page, "First reply");
  const replies = page.locator("[data-role=assistant]");
  await expect(replies.first()).toContainText("First historical reply.");
  await expect(replies.first().locator("footer")).toContainText("Worked for");
  const held = await state.controller.call<{ gate: string }>("queueScript", {
    lease: state.lease.lease,
    chunks: ["Second reply still running."],
    delay: 100,
    gate: "held",
  });
  await prompt(page, "Second reply");
  await expect(replies).toHaveCount(2);
  await replies.last().locator(".otk-entity-pill").first().focus();
  await expect(page.locator(".otk-entity-facts:visible").last()).not
    .toContainText("Completed");
  await page.keyboard.press("Escape");
  // Use reader input: the viewport intentionally compensates raw scrollTop
  // writes while following. Scrolling away acquires historical virtual rows.
  await page.locator(".otk-messages").hover();
  await page.mouse.wheel(0, -2000);
  const firstPill = replies.first().locator(".otk-entity-pill").first();
  await firstPill.focus();
  const card = page.locator(".otk-entity-facts").filter({
    hasText: "This reply",
  }).first();
  const turnTime = replies.first().locator(".otk-turn-time time");
  await expect(card.locator('dt:text-is("This reply") + dd time'))
    .toHaveText(await turnTime.textContent() ?? "");
  await expect(card).toContainText("Completed");
  await expect(card).toContainText("Session now");
  await expect(card).toContainText("Working");
  // The reply belongs to the session already on screen, not an Open target.
  await expect(
    page.locator(".otk-entity:has(.otk-entity-facts:visible)").getByRole(
      "button",
      { name: "Open", exact: true },
    ),
  ).toHaveCount(0);
  await firstPill.click();
  await expect(card).toBeVisible();
  const clock = card.locator('dt:text-is("Completed") + dd time');
  const completed = await clock.getAttribute("datetime");
  await state.release(held.gate);
  await expect(clock).toHaveAttribute("datetime", completed!);
  await expect(card.locator(".otk-entity-status")).not.toContainText("Working");
  await state.product("prefs.set", { key: "animationsOff", value: true });
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect.poll(() =>
      page.evaluate(() => document.documentElement.dataset.otkTheme)
    ).toBe(theme);
    await info.attach(`entity-facts-${theme}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }
  await page.keyboard.press("Escape");
  await replies.last().locator(".otk-entity-pill").first().focus();
  await expect(page.locator(".otk-entity-facts:visible").last()).toContainText(
    "This reply",
  );
});

test(
  "sessions.live-shell-capsule-borrows-native-inventory-and-real-capabilities",
  {
    tag: ["@messages", "@sessions", "@isolated"],
  },
  async ({ isolatedState: state, page }, info) => {
    test.setTimeout(120000);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Live shell inventory",
    });
    await openSession(state, page, session.id);
    const sessionID = session.id;
    await composerPrompt(page).press("!");
    await composerPrompt(page).pressSequentially("sleep 120");
    await composerPrompt(page).press("Enter");
    try {
      if (state.controller.info!.version.startsWith("2.")) {
        const capsule = page.getByRole("button", {
          name: "Running work: 1 shell",
          exact: true,
        });
        await expect(capsule).toBeVisible();
        await capsule.click();
        const item = page.locator("[data-running-work^='shell/']");
        await expect(item).toContainText("sleep 120");
        await expect(item).toContainText("Running for");
        await expect(item.getByRole("button", { name: "Stop", exact: true }))
          .toHaveCount(0);
        await state.product("prefs.set", { key: "animationsOff", value: true });
        for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
          await state.product("prefs.set", { key: "theme", value: theme });
          await expect(page.locator("html")).toHaveAttribute(
            "data-otk-theme",
            theme,
          );
          await info.attach(`live-work-${theme}`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
        }
        await page.keyboard.press("Escape");
        await page.reload();
        await expect(capsule).toBeVisible();
      } else {
        await expect(page.locator(`[data-session="${sessionID}"]`).first())
          .toHaveAttribute("data-status", "busy");
        // This native has no individual shell inventory. A transcript row or
        // session lamp cannot certify one on its behalf.
        await expect(page.locator(".otk-live-work-trigger")).toHaveCount(0);
        await expect(page.locator("[data-running-work^='shell/']")).toHaveCount(
          0,
        );
      }
    } finally {
      await state.product("session.abort", { sessionID });
    }
  },
);
