// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { pasteText, prompt } from "../../pages/composer.ts";
import {
  composerError,
  reloadComposerError,
} from "../../pages/composer-error.ts";

test.use({ profile: "transport-shell" });
test("composer.literal-pasted-bang-and-ordinary-native-typing", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Literal bang",
  });
  await openSession(state, page, session.id);
  await pasteText(page, "!literal");
  await expect(prompt(page)).toHaveValue("!literal");
  expect(
    await prompt(page).evaluate(
      (t) => [
        (t as HTMLTextAreaElement).selectionStart,
        (t as HTMLTextAreaElement).selectionEnd,
      ],
    ),
  ).toEqual([8, 8]);
  await page.keyboard.insertText("x");
  await expect(prompt(page)).toHaveValue("!literalx");
  await expect(page.locator(".otk-prompt > label")).toHaveText("Prompt");
});
test("composer.shell-native-output-local-mode-exit-and-real-long-command", {
  tag: ["@composer", "@isolated", "@duration"],
}, async ({ isolatedState: state, page }) => {
  test.setTimeout(120_000);
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Shell",
  });
  await openSession(state, page, session.id);
  await prompt(page).press("!");
  await prompt(page).pressSequentially("echo otk");
  await expect(page.locator(".otk-prompt > label")).toHaveText("Shell");
  await expect(prompt(page)).toHaveValue("echo otk");
  await prompt(page).press("Escape");
  await expect(page.locator(".otk-prompt > label")).toHaveText("Prompt");
  await expect(prompt(page)).toHaveValue("echo otk");
  await prompt(page).press("Home");
  await prompt(page).press("!");
  await prompt(page).press("Enter");
  await expect(page.locator("[data-tool=bash][data-tool-status=completed]"))
    .toContainText("otk");
  await expect(prompt(page)).toHaveValue("");
  await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
  await prompt(page).press("!");
  await prompt(page).pressSequentially("sleep 31; echo long-shell-finished");
  await prompt(page).press("Enter");
  await expect(page.locator("[data-tool=bash][data-tool-status=running]"))
    .toBeVisible();
  await expect(prompt(page)).toHaveValue("sleep 31; echo long-shell-finished");
  await expect(page.locator(".otk-operation-feedback[role=status]"))
    .toContainText("Running command");
  await prompt(page).fill("next draft during command");
  await expect(prompt(page)).toBeEditable();
  await expect(
    page.locator(
      ".otk-prompt button[type=submit], .otk-composer-dock [role=alert]",
    ),
  ).toHaveCount(0);
  await expect(
    page.locator("[data-tool=bash][data-tool-status=completed]").filter({
      hasText: "long-shell-finished",
    }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(prompt(page)).toHaveValue("next draft during command");
  await expect(page.locator(".otk-prompt [role=alert]")).toHaveCount(0);
});
test.describe("direct native deferred failure", () => {
  test.use({ profile: "composer-shell-failure" });
  test(
    "composer.deferred-shell-failure-keeps-new-draft-and-reloads-authority",
    { tag: ["@composer", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      const session = await state.native<{ id: string; nativeID: string }>(
        "/session",
        "POST",
        {
          title: "Deferred shell failure",
        },
      );
      const frames = await wire(page);
      await openSession(state, page, session.id);
      await prompt(page).fill("keep this draft");
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "fail",
        sessionID: session.nativeID,
      });
      await expect(page.locator(".otk-session-error")).toBeVisible();
      const snapshot = await composerError(state, page, frames, session.id);
      expect(snapshot.error).toMatch(/^Agent not found: "missing-otk-agent"\./);
      await expect(prompt(page)).toHaveValue("keep this draft");
      await reloadComposerError(state, page, frames, session.id, snapshot);
      expect((await state.observe<{ requests: unknown[] }>()).requests)
        .toHaveLength(0);
    },
  );
});
