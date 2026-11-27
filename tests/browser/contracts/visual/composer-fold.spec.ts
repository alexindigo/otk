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
for (const zoom of [1, 1.25, 1.5, 1.75, 2]) {
  test.describe(`Composer at ${zoom * 100}% zoom`, () => {
    const viewport = {
      width: Math.round(1280 / zoom),
      height: Math.round(800 / zoom),
    };
    test.use({ viewport, deviceScaleFactor: zoom });

    test(`visual.composer-fold.${zoom * 100}.sweep`, {
      tag: ["@visual", "@composer", "@isolated"],
    }, async ({ isolatedState: state, page }) => {
      await page.setViewportSize({ width: 1280, height: viewport.height });
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: "Measured composer toolbar",
      });
      await openSession(state, page, session.id);
      await page.locator(".otk-model-picker > button").click();
      await page.locator(
        `.otk-model-picker [data-picker-key='["fake2","scripted"]'] .otk-picker-option`,
      ).click();
      await expect(page.getByRole("button", { name: "Variant: Default" }))
        .toBeVisible();
      await page.setViewportSize(viewport);
      const frame = page.locator(".otk-composer");
      const input = frame.getByRole("textbox", { name: "Prompt", exact: true });
      const toolbar = frame.locator(".otk-prompt-actions");
      const layout = {
        leftCollapsed: false,
        rightCollapsed: false,
        leftWidth: 200,
      };
      const more = toolbar.getByRole("button", { name: "More actions" });
      const measure = () =>
        frame.evaluate((box) => {
          const errors: string[] = [];
          const rect = (el: Element) => el.getBoundingClientRect();
          const prompt = box.querySelector(".otk-prompt")!;
          const row = prompt.querySelector(".otk-prompt-actions")!;
          const fold = row.querySelector(".otk-overflow-row")!;
          const full = fold.getAttribute("data-fit-mode") === "full";
          const mode = fold.getAttribute("data-fit-mode") ?? "unknown";
          const frame = rect(box), bar = rect(row);
          const stroke = parseFloat(getComputedStyle(box).borderRightWidth);
          const inset = parseFloat(getComputedStyle(prompt).paddingRight);
          const gap = parseFloat(getComputedStyle(row).columnGap);
          const pencil = rect(box.querySelector('[aria-label="Edit prompt"]')!);
          const send = rect(row.querySelector("[data-primary-action]")!);
          const floor = 2 * (stroke + inset + pencil.width + gap) + send.width;
          const controls = Array.from(row.querySelectorAll("button")).filter((
            button,
          ) =>
            !button.closest("[inert], [popover]") &&
            button.getClientRects().length
          );
          const face = fold.querySelector(
            ".otk-overflow-measure .otk-prompt-context",
          );
          const live = row.querySelector(
            ".otk-prompt-context:not([inert] *, [popover] *)",
          );
          const marks = [
            document.scrollingElement!,
            box.closest(".otk-composer-dock")!,
            box,
            prompt,
            row,
          ];
          for (const el of marks) {
            if (el.scrollWidth > el.clientWidth + 0.5) {
              errors.push(`horizontal overflow: ${el.className || el.tagName}`);
            }
          }
          if (
            send.left < frame.left + stroke + inset - .5 ||
            Math.abs(send.right - (frame.right - stroke - inset)) > .5
          ) {
            errors.push("Send clipped or off its right edge");
          }
          const corner = [
            pencil.top - frame.top - stroke,
            frame.right - stroke - pencil.right,
            pencil.width,
            pencil.height,
          ];
          if (
            Math.abs(corner[0] - inset) > 1 ||
            Math.abs(corner[0] - corner[1]) > 1 ||
            Math.abs(pencil.right - send.right) > .5
          ) {
            errors.push("pencil corner inset or Send alignment");
          }
          const field = box.querySelector(".otk-prompt-field");
          if (
            !field ||
            rect(box.querySelector("textarea")!).right >
              pencil.left - parseFloat(getComputedStyle(field).columnGap) + .5
          ) {
            errors.push("textarea extends into the pencil slot");
          }
          if (frame.width + .5 >= floor) {
            if (full) {
              const labels = live?.querySelectorAll(
                ".otk-picker-label, .otk-prompt-setting, .otk-control-value-label, .otk-model-label > *",
              ) ?? [];
              for (const el of Array.from(labels)) {
                if (
                  el.clientWidth !== 0 && el.scrollWidth > el.clientWidth + .5
                ) errors.push(`whole or folded: ${el.textContent}`);
              }
              if (
                !face || !live ||
                Math.abs(rect(face).width - rect(live).width) > 1
              ) {
                errors.push(
                  `whole or folded: face/live ${face && rect(face).width}/${
                    live && rect(live).width
                  }`,
                );
              }
            } else if (
              live ||
              !controls.some((button) =>
                button.getAttribute("aria-label") === "Next message settings"
              )
            ) {
              errors.push(`whole or folded: settings not folded in ${mode}`);
            }
            for (const [i, control] of controls.entries()) {
              const b = rect(control);
              const label = control.getAttribute("aria-label");
              if (
                b.width <= 0 || b.left < bar.left - .5 ||
                b.right > bar.right + .5
              ) errors.push(`${label} outside toolbar`);
              for (const other of controls.slice(i + 1)) {
                const o = rect(other);
                if (
                  Math.min(b.right, o.right) - Math.max(b.left, o.left) > .5 &&
                  Math.min(b.bottom, o.bottom) - Math.max(b.top, o.top) > .5
                ) {
                  errors.push(
                    `${label} overlaps ${other.getAttribute("aria-label")}`,
                  );
                }
              }
            }
          }
          return { errors, mode, corner, width: frame.width, floor };
        });
      const ranks = ["full", "compact", "collapsed"];
      const problems: string[] = [];
      for (const scale of ["100", "125"]) {
        await state.product("prefs.set", { key: "textSize", value: scale });
        await expect.poll(() =>
          page.locator("html").evaluate((el) =>
            Number(getComputedStyle(el).getPropertyValue("--otk-scale"))
          )
        ).toBe(Number(scale) / 100);
        await page.evaluate(() => document.fonts.ready.then(() => {}));
        const corners = new Map<number, number[]>();
        let checkedMore = false;
        for (const long of [false, true]) {
          // Enter the draft before narrowing: a below-floor shell can leave no
          // editable text lane. The geometry is still checked at every width.
          await page.setViewportSize({ width: 1280, height: viewport.height });
          await input.fill(
            long
              ? Array.from({ length: 30 }, (_, i) => `Draft line ${i + 1}`)
                .join("\n")
              : "",
          );
          if (long) {
            await input.evaluate((el: HTMLTextAreaElement) =>
              el.scrollTop = el.scrollHeight
            );
          }
          await page.setViewportSize(viewport);
          let previous = 0;
          for (const rightWidth of [280, 320, 360, 400, 440, 480]) {
            await state.product("layout.patch", { ...layout, rightWidth });
            await expect(page.getByRole("separator", { name: /right/i }))
              .toHaveAttribute("aria-valuenow", String(rightWidth));
            await page.evaluate(() =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve())
                )
              )
            );
            const result = await measure();
            const { errors, mode, width, floor, corner } = result;
            const current = ranks.indexOf(mode);
            if (current < previous) {
              errors.push(`fold order regressed to ${mode}`);
            }
            previous = current;
            if (!long) corners.set(rightWidth, corner);
            else {
              const empty = corners.get(rightWidth);
              if (
                empty &&
                corner.some((value, i) => Math.abs(value - empty[i]) > .5)
              ) errors.push("long draft moved the pencil in its frame");
            }
            if (mode === "collapsed" && width >= floor && !checkedMore) {
              checkedMore = true;
              await expect(
                toolbar.getByRole("button", {
                  name: /Attach files|Open terminal/,
                }),
              ).toHaveCount(0);
              await more.click();
              const menu = page.getByRole("menu", { name: "More actions" });
              await expect(menu.getByRole("menuitem")).toHaveText([
                "Attach files",
                "Open terminal",
              ]);
              await page.keyboard.press("Escape");
              await expect(menu).toHaveCount(0);
            }
            problems.push(
              ...errors.map((error) =>
                `${scale}% text, panel ${rightWidth}, frame ${width}, draft ${long}: ${error}`
              ),
            );
            if (width <= floor + 8) break;
          }
        }
      }
      expect(problems).toEqual([]);
    });
  });
}
