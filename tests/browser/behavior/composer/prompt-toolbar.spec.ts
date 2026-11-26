// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "composer-pickers" });

test("composer.prompt-toolbar-keeps-controls-in-separate-tracks", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await state.product("layout.patch", {
    leftCollapsed: false,
    rightCollapsed: false,
    leftWidth: 250,
    rightWidth: 298,
  });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Prompt toolbar geometry",
  });
  await openSession(state, page, session.id);
  const input = page.getByRole("textbox", { name: "Prompt", exact: true });
  await expect(input).toBeVisible();
  await page.locator(".otk-model-picker > button").click();
  await page.locator(
    `.otk-model-picker [data-picker-key='["fake2","scripted"]'] .otk-picker-option`,
  ).click();
  const toolbar = page.locator(".otk-prompt-actions");
  await expect(toolbar.getByRole("button", { name: "Variant:", exact: false }))
    .toBeVisible();
  for (const [width, scale] of [[900, "125"], [1280, "100"]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await state.product("prefs.set", { key: "textSize", value: scale });
    await expect.poll(() =>
      page.locator("html").evaluate((html) =>
        Number(getComputedStyle(html).getPropertyValue("--otk-scale"))
      )
    ).toBe(Number(scale) / 100);
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() =>
      toolbar.evaluate((row) => {
        const bounds = row.getBoundingClientRect();
        const style = getComputedStyle(row);
        const controls = Array.from(row.querySelectorAll("button")).filter(
          (button) =>
            !button.closest("[inert], [popover]") &&
            button.getClientRects().length > 0,
        );
        const names = controls.map((b) => b.getAttribute("aria-label") ?? "");
        const rects = controls.map((button) => button.getBoundingClientRect());
        const errors: string[] = [];
        for (const action of ["Attach files", "Open terminal", "Edit prompt"]) {
          if (!names.includes(action)) errors.push(`Missing ${action}`);
        }
        const send = row.querySelector("[data-primary-action]");
        if (!send || !controls.includes(send as HTMLButtonElement)) {
          errors.push("Missing primary action");
        }
        for (const [i, box] of rects.entries()) {
          if (
            box.width === 0 || box.left < bounds.left - 0.5 ||
            box.right > bounds.right + 0.5
          ) {
            errors.push(`${names[i]} is outside the toolbar`);
          }
          for (const icon of Array.from(controls[i].querySelectorAll("svg"))) {
            const artwork = icon.getBoundingClientRect();
            if (
              artwork.left < box.left - 0.5 || artwork.right > box.right + 0.5
            ) {
              errors.push(`${names[i]} artwork spills out of its control`);
            }
          }
          for (const [j, other] of rects.entries()) {
            if (
              j > i && box.left < other.right && other.left < box.right &&
              box.top < other.bottom && other.top < box.bottom
            ) {
              errors.push(`${names[i]} intersects ${names[j]}`);
            }
          }
        }
        const contentRight = bounds.right - parseFloat(style.paddingRight) -
          parseFloat(style.borderRightWidth);
        const trailing = row.querySelector(".otk-prompt-action-group");
        if (
          !trailing ||
          Math.abs(trailing.getBoundingClientRect().right - contentRight) > 0.5
        ) {
          errors.push(
            "Trailing actions are not flush with the toolbar content",
          );
        }
        return errors;
      }), { message: `${width}px at ${scale}%` }).toEqual([]);
    const compact = toolbar.getByRole("button", {
      name: "Next message settings",
    });
    if (width === 900) {
      await compact.click();
      const settings = page.getByRole("group", {
        name: "Next message settings",
      });
      const variant = settings.getByRole("button", {
        name: "Variant: Default",
      });
      await variant.click();
      await page.getByRole("option", { name: "Low" }).click();
      await expect(input).toBeFocused();
      // An existing direct command works even when the folded settings are closed.
      await page.keyboard.press("Control+'");
      const search = page.getByPlaceholder("Search models...");
      await expect(search).toBeFocused();
      await page.keyboard.press("Escape");
    } else {
      await expect(compact).toHaveCount(0);
      await expect(toolbar.getByRole("button", { name: "Variant: Low" }))
        .toBeVisible();
    }
  }
});
