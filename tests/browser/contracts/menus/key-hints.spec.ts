// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/composer.ts";
test.describe("live hints", () => {
  test.use({ profile: "contract-menus-hints" });
  test(
    "menus.command-hints-mounted-hidden-rebind-unbind-reset-and-native-actions",
    { tag: ["@menus", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      await openSession(state, page, "tstv1-core");
      const lamp = page.locator('[data-crumb="tstv1-core"] .otk-status-light');
      await expect(lamp).toHaveAttribute("data-state", "none");
      const button = page.locator(".otk-prompt button[type=submit]");
      const defaultTitle =
        "Send (Enter); Shift+Enter for newline; Esc twice to interrupt";
      const reboundTitle =
        "Send (Ctrl+Enter); Alt+Enter for newline; Ctrl+q twice to interrupt";
      await expect(button).toHaveCount(0);
      await prompt(page).fill("Inspect current shortcut hints");
      await page.locator(".otk-keys-entry").click();
      await expect(page.locator('[data-binding="prompt.submit"] kbd'))
        .toHaveText("Enter");
      await expect(button).toHaveAttribute("title", defaultTitle);
      await page.keyboard.press("Escape");
      await state.product("prefs.set", {
        key: "keymap",
        value: {
          "prompt.submit": "Ctrl+Enter",
          "prompt.newline": "Alt+Enter",
          "session.interrupt": "Ctrl+q",
          "palette.open": "Ctrl+j",
        },
      });
      await page.locator(".otk-keys-entry").click();
      await expect(page.locator('[data-binding="prompt.submit"] kbd'))
        .toHaveText("Ctrl+Enter");
      await expect(button).toHaveAttribute("title", reboundTitle);
      await expect(page.locator(".otk-sidebar-commands button").first())
        .toHaveAttribute("title", "Search commands (Ctrl+j)");
      await page.keyboard.press("Escape");
      await page.reload();
      await prompt(page).fill("Inspect saved shortcut hints");
      await page.locator(".otk-keys-entry").click();
      await expect(page.locator('[data-binding="prompt.submit"] kbd'))
        .toHaveText("Ctrl+Enter");
      await expect(button).toHaveAttribute("title", reboundTitle);
      await page.keyboard.press("Escape");
      await prompt(page).fill("First line");
      await page.keyboard.press("Alt+Enter");
      await expect(prompt(page)).toHaveValue("First line\n");
      expect((await state.observe<{ sends: unknown[] }>()).sends).toHaveLength(
        0,
      );
      await page.keyboard.press("Control+Enter");
      await expect(prompt(page)).toHaveValue("");
      await expect.poll(async () =>
        (await state.observe<{ sends: { parts: unknown[] }[] }>()).sends.map(
          (send) => send.parts,
        )
      ).toEqual([[{ kind: "text", text: "First line\n" }]]);
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "hold",
      });
      await expect(lamp).toHaveAttribute("data-state", "working");
      await page.keyboard.press("Control+q");
      await expect(page.locator("[data-interrupt-confirmation]")).toHaveText(
        "Ctrl+q again to interrupt",
      );
      expect((await state.observe<{ aborts: number }>()).aborts).toBe(0);
      await page.keyboard.press("Control+q");
      await expect(page.locator("[data-interrupt-confirmation]")).toHaveCount(
        0,
      );
      await expect.poll(async () =>
        (await state.observe<{ aborts: number }>()).aborts
      ).toBe(1);
      await expect(lamp).toHaveAttribute("data-state", "none");
      await prompt(page).fill("Inspect reset shortcut hints");
      await expect(button).toHaveAttribute("title", reboundTitle);
      await state.product("prefs.set", {
        key: "keymap",
        value: {
          "prompt.submit": "",
          "prompt.newline": "",
          "session.interrupt": "",
        },
      });
      await page.locator(".otk-keys-entry").click();
      await expect(page.locator('[data-binding="prompt.submit"] kbd'))
        .toHaveText("Unbound");
      await expect(button).toHaveAttribute("title", "Send");
      await page.keyboard.press("Escape");
      await state.product("prefs.set", { key: "keymap", value: {} });
      await page.locator(".otk-keys-entry").click();
      await expect(page.locator('[data-binding="prompt.submit"] kbd'))
        .toHaveText("Enter");
      await expect(button).toHaveAttribute("title", defaultTitle);
      await page.keyboard.press("Escape");
    },
  );
  test("menus.dialog-editor-no-static-hints-save-cancel-native-focus", {
    tag: ["@menus", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await state.product("prefs.set", { key: "animationsOff", value: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSession(state, page, "tstv1-core");
    await prompt(page).fill("Keep this prompt");
    const edit = page.getByRole("button", { name: "Edit prompt", exact: true });
    await edit.click();
    const editor = page.locator("textarea[name=editor]");
    await expect(editor).toHaveValue("Keep this prompt");
    await expect(page.locator("dialog[open] .otk-surface-title button"))
      .toHaveText("Close");
    await expect(page.locator(".otk-editor p")).toHaveText(
      "Save to keep changes",
    );
    await editor.fill("Saved prompt");
    await page.locator(".otk-editor footer button").last().click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(prompt(page)).toHaveValue("Saved prompt");
    await expect(edit).toBeFocused();
    await page.locator(".otk-keys-entry").click();
    await expect(page.locator('[data-binding="session.interrupt"]'))
      .toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await edit.click();
    await editor.fill("Cancel this edit");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(prompt(page)).toHaveValue("Saved prompt");
    await expect(edit).toBeFocused();
  });
});
test.describe("permission widget keys", () => {
  test.use({ profile: "contract-menus-permission" });
  test("menus.permission-fixed-keys-respect-text-focus-and-review-layers", {
    tag: ["@menus", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/#/local/tstv1-core`);
    const buttons = page.locator(".otk-permission-actions button");
    await expect(buttons).toHaveCount(3);
    expect(
      await buttons.evaluateAll((items) =>
        items.map((item) => item.getAttribute("title"))
      ),
    ).toEqual([
      "Allow once (1 when focused)",
      "Review future grant (2 when focused)",
      "Reject (3 when focused)",
    ]);
    await page.locator(".otk-permission-actions input").click();
    await page.keyboard.press("1");
    await expect(page.locator(".otk-permission-actions input")).toHaveValue(
      "1",
    );
    expect((await state.observe<{ replies: unknown[] }>()).replies).toEqual([]);
    await buttons.nth(1).focus();
    await page.keyboard.press("2");
    await expect(page.locator(".otk-permission-confirm")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".otk-permission-confirm")).toHaveCount(0);
    await page.keyboard.press("3");
    await expect(page.locator(".otk-permission-reject")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".otk-permission-reject")).toHaveCount(0);
    await page.keyboard.press("1");
    await expect.poll(async () =>
      (await state.observe<{ replies: { reply: string }[] }>()).replies.map(
        (r) => r.reply,
      )
    ).toEqual(["once"]);
  });
});
test.describe("question widget keys", () => {
  test.use({ profile: "contract-menus-question" });
  test("menus.question-escape-keeps-answer-then-skips-from-controls", {
    tag: ["@menus", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await expect(page.locator(".otk-question-actions button").nth(1))
      .toHaveAttribute(
        "title",
        "Skip question (Esc with question controls focused)",
      );
    const answer = page.locator("textarea[name=question-answer]");
    await answer.fill("Keep my answer");
    await page.keyboard.press("Escape");
    await expect(page.locator(".otk-question-actions .otk-primary"))
      .toBeFocused();
    expect((await state.observe<{ answers: unknown[] }>()).answers).toEqual([]);
    await expect(answer).toHaveValue("Keep my answer");
    await page.keyboard.press("Escape");
    await expect.poll(async () =>
      (await state.observe<{ answers: unknown[] }>()).answers
    ).toEqual([null]);
  });
});
