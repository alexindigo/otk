// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  chips,
  completeUpload,
  holdUploads,
  messages,
  pasteText,
  prompt,
  reply,
  upload,
} from "../../pages/composer.ts";

test(
  "composer.editor-paste-save-cancel-expanded-bytes",
  { tag: "@composer" },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Editor",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    const source = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    await pasteText(page, source);
    await expect(chips(page)).toContainText("[Pasted ~200 lines]");
    await chips(page).locator("button").first().click();
    const editor = page.locator("textarea[name=editor]");
    await expect(editor).toHaveValue(source);
    await editor.fill(source + "\nedited line");
    await page.locator(".otk-editor footer button").last().click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(chips(page)).toContainText("~201 lines");
    await chips(page).locator("button").first().click();
    await editor.fill("cancel this");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await state.queue(["Expanded paste received."]);
    await page.locator(".otk-prompt button[type=submit]").click();
    await expect(chips(page)).toHaveCount(0);
    // insertChip owns a trailing separator; expanding the inline token preserves it.
    const expanded = source + "\nedited line ";
    await expect.poll(async () =>
      (await messages(state, session.id)).some((row) =>
        row.info.role === "user" &&
        row.parts.some((p) => p.type === "text" && p.text === expanded)
      )
    ).toBe(true);
    await reply(state, page, session.id, "Expanded paste received.");
    await prompt(page).fill("/editor surrounding [Pasted ~201 lines]");
    await prompt(page).press("Enter");
    await expect(editor).toHaveValue("surrounding [Pasted ~201 lines]");
    await editor.fill("edited whole prompt");
    await page.locator(".otk-editor footer button").last().click();
    await expect(prompt(page)).toHaveValue("edited whole prompt");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await state.queue(["Whole editor prompt received."]);
    await prompt(page).press("Enter");
    await expect.poll(() =>
      frames.sent.filter(({ frame }) => frame.method === "session.prompt")
        .length
    ).toBe(2);
    await expect.poll(async () =>
      (await messages(state, session.id)).filter((row) =>
        row.info.role === "user"
      ).map((row) =>
        row.parts.filter((p) => p.type === "text").map((p) => p.text).join("")
      )
    ).toEqual([expanded, "edited whole prompt"]);
    await expect.poll(async () =>
      JSON.stringify((await state.observe<{ requests: unknown[] }>()).requests)
    ).toContain("edited whole prompt");
    await reply(state, page, session.id, "Whole editor prompt received.");
    await expect(
      page.locator("[data-role=user] .otk-text").filter({
        hasText: "edited whole prompt",
      }),
    ).toHaveText("edited whole prompt");
  },
);

test(
  "composer.editor-late-upload-retains-current-draft",
  { tag: "@composer" },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Editor upload ownership",
    });
    await openSession(state, page, session.id);
    await holdUploads(page);
    await upload(page, [{
      name: "editor-owned.txt",
      bytes: btoa("editor-owned-bytes"),
    }]);
    await expect(chips(page)).toContainText("reading…");
    await expect.poll(() =>
      page.evaluate(() =>
        (globalThis as unknown as Window).composerReads.length
      )
    )
      .toBe(1);
    await page.getByRole("button", { name: "Edit prompt", exact: true })
      .click();
    const editor = page.locator("textarea[name=editor]");
    await editor.fill("editor before [File 1] editor after");
    await completeUpload(page, 0);
    await expect(chips(page)).not.toContainText("reading…");
    await expect(editor).toHaveValue("editor before [File 1] editor after");
    await page.locator(".otk-editor footer button").last().click();
    await expect(prompt(page)).toHaveValue(
      "editor before [File 1] editor after",
    );
    await state.queue(["Editor attachment received."]);
    await page.locator(".otk-prompt button[type=submit]").click();
    await expect.poll(async () =>
      (await messages(state, session.id)).find((row) =>
        row.info.role === "user"
      )?.parts.find((p) => p.filename === "editor-owned.txt")?.url
    ).toBe("data:text/plain;base64," + btoa("editor-owned-bytes"));
    const parts =
      (await messages(state, session.id)).find((row) =>
        row.info.role === "user"
      )!.parts;
    expect(
      parts.some((p) =>
        p.type === "text" && p.text?.includes("editor before") &&
        p.text.includes("editor after")
      ),
    ).toBe(true);
    await reply(state, page, session.id, "Editor attachment received.");
  },
);
