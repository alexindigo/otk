// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { chips, holdUploads, pasteText, upload } from "../../pages/composer.ts";

test(
  "composer.editor-dialog-and-action-geometry",
  { tag: "@composer" },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Editor geometry",
    });
    await openSession(state, page, session.id);
    await holdUploads(page);
    await upload(page, [{ name: "geometry.txt", bytes: btoa("geometry") }]);
    await expect(chips(page)).toContainText("reading…");
    const action = page.getByRole("button", {
      name: "Edit prompt",
      exact: true,
    });
    await expect(action).toHaveAttribute("title", "Edit prompt");
    await expect(action).toHaveClass(/otk-icon-button/);
    await expect(action).toHaveText("");
    await expect(action.locator("svg")).toHaveAttribute("aria-hidden", "true");
    await expect(action.locator("svg path")).toBeAttached();
    await expect.poll(() =>
      action.boundingBox().then((r) => r && [r.width, r.height])
    ).toEqual([28, 28]);
    await expect(page.locator(".otk-send-button")).toHaveCount(0);
    await page.evaluate(() =>
      (globalThis as unknown as Window).composerReads[0].complete()
    );
    await pasteText(
      page,
      Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    await chips(page).filter({ hasText: "200 lines" }).locator("button").first()
      .click();
    await expect(page.locator("textarea[name=editor]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() =>
      page.evaluate(() => {
        const d = document.querySelector(".otk-dialog")!
            .getBoundingClientRect(),
          t = document.querySelector(".otk-editor textarea")!
            .getBoundingClientRect(),
          f = document.querySelector(".otk-editor footer")!
            .getBoundingClientRect();
        return t.height > innerHeight * .6 && f.top >= t.bottom &&
          d.bottom - f.bottom < 24 && Math.abs(d.top - 16) <= .5 &&
          Math.abs(innerHeight - d.bottom - 16) <= .5;
      })
    ).toBe(true);
  },
);
