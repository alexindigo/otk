// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { expectViewportEnd } from "../../pages/viewport-commit.ts";

test.use({ profile: "composer-pickers" });

test("visual.composer-fold.100.corner", {
  tag: ["@visual", "@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Composer corner",
  });
  await openSession(state, page, session.id);
  const frame = page.locator(".otk-composer");
  const input = frame.getByRole("textbox", { name: "Prompt", exact: true });
  const pencil = frame.getByRole("button", { name: "Edit prompt" });
  await expectViewportEnd(page);
  const geometry = () =>
    pencil.evaluate((button) => {
      const frame = button.closest(".otk-composer")!;
      const prompt = button.closest(".otk-prompt")!;
      const b = button.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const s = getComputedStyle(frame);
      const p = getComputedStyle(prompt);
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      const send = frame.querySelector("[data-primary-action]")!
        .getBoundingClientRect();
      return {
        top: b.top - f.top - parseFloat(s.borderTopWidth),
        right: f.right - parseFloat(s.borderRightWidth) - b.right,
        inset: parseFloat(p.paddingRight),
        sendGap: b.right - send.right,
        textGap: b.left - frame.querySelector("textarea")!
          .getBoundingClientRect().right,
        width: b.width,
        height: b.height,
        iconGaps: [
          icon.left - b.left,
          b.right - icon.right,
          icon.top - b.top,
          b.bottom - icon.bottom,
        ],
      };
    });
  const empty = await geometry();
  expect(Math.abs(empty.top - empty.right), "even pencil corner inset")
    .toBeLessThanOrEqual(1);
  expect(Math.abs(empty.top - empty.inset)).toBeLessThanOrEqual(1);
  expect(Math.abs(empty.sendGap)).toBeLessThanOrEqual(0.5);
  expect(empty.textGap).toBeGreaterThanOrEqual(7.5);

  await input.fill(
    Array.from({ length: 30 }, (_, i) => `Draft line ${i + 1}`).join("\n"),
  );
  await input.evaluate((el: HTMLTextAreaElement) =>
    el.scrollTop = el.scrollHeight
  );
  expect(await input.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // The dock is bottom-anchored: compare the pencil in its frame, not the page.
  await expect.poll(geometry).toEqual(empty);
  await pencil.hover();
  await expect(pencil).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const hover = await geometry();
  expect(hover).toEqual(empty);
  expect(Math.max(...hover.iconGaps) - Math.min(...hover.iconGaps))
    .toBeLessThanOrEqual(1);

  // Tab in the textarea is an agent shortcut; traverse backwards natively.
  const firstTool = frame.locator(".otk-prompt-actions button:visible:enabled")
    .first();
  await firstTool.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(pencil).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  for (const key of ["Enter", "Space"]) {
    await firstTool.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(pencil).toBeFocused();
    await page.keyboard.press(key);
    const editor = page.getByRole("dialog", { name: "Edit prompt" });
    await expect(editor.getByRole("textbox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(pencil).toBeFocused();
  }
});
