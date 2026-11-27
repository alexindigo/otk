// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator, Page } from "@playwright/test";
import { expect } from "../fixtures/evidence.ts";

/** The label rows share one pointer, keyboard, region and focus contract. */
export async function labelDisclosure(
  trigger: Locator,
  initiallyOpen = false,
  sharedRegion = false,
): Promise<Locator> {
  await expect(trigger).toHaveAttribute("aria-expanded", String(initiallyOpen));
  await expect(trigger).toHaveAttribute("aria-controls", /\S+/);
  const id = (await trigger.getAttribute("aria-controls"))!;
  const region = trigger.page().locator(`[id=${JSON.stringify(id)}]`);
  await expect(region).toHaveAttribute("role", "group");
  if (initiallyOpen) await trigger.press("ArrowLeft");
  if (!sharedRegion) await expect(region).toHaveAttribute("hidden", "");
  const glyph = trigger.locator(".otk-disclosure-icon svg");
  await glyph.click();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(region).not.toHaveAttribute("hidden", "");
  await trigger.locator(".otk-disclosure-label").click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  if (!sharedRegion) await expect(region).toHaveAttribute("hidden", "");
  for (
    const [key, expanded] of [
      ["Enter", "true"],
      ["Space", "false"],
      ["ArrowRight", "true"],
      ["ArrowRight", "true"],
      ["ArrowLeft", "false"],
      ["ArrowLeft", "false"],
    ]
  ) {
    await trigger.press(key);
    await expect(trigger).toHaveAttribute("aria-expanded", expanded);
    await expect(trigger).toBeFocused();
  }
  await expect(glyph).toHaveCSS("transition-duration", "0s");
  await expect(region).toHaveCSS("transition-duration", "0s");
  const spare = await trigger.evaluate((button) => {
    if (button.classList.contains("otk-tree-trigger")) {
      const caption = button.children[2];
      const row = button.parentElement!;
      const junction = row.querySelector(":scope > .otk-tree-junction")!;
      const art = row.querySelector(
        ":scope > .otk-tree-frame > .otk-tree-node-lane",
      )!;
      const clone = caption.cloneNode(true) as HTMLElement;
      clone.style.cssText =
        "position:absolute;inline-size:max-content;max-inline-size:none;visibility:hidden";
      clone.style.paddingInline = getComputedStyle(caption).paddingInline;
      button.append(clone);
      const natural = clone.getBoundingClientRect().width;
      clone.remove();
      const rails = [junction, art].map((lane) => lane.getBoundingClientRect());
      const content = caption.getBoundingClientRect();
      const bounds = button.getBoundingClientRect();
      const leading = [...rails, content];
      return Math.max(
        0,
        content.width - natural,
        Math.min(...leading.map((part) => part.left)) - bounds.left,
        bounds.right - Math.max(...leading.map((part) => part.right)),
      );
    }
    const style = getComputedStyle(button);
    const widths = Array.from(
      button.children,
      (item) => item.getBoundingClientRect().width,
    );
    return button.getBoundingClientRect().width -
      widths.reduce((sum, width) => sum + width, 0) -
      (widths.length - 1) * (parseFloat(style.columnGap) || 0) -
      parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd);
  });
  expect(Math.abs(spare)).toBeLessThanOrEqual(1);
  return region;
}

/** Retire the transcript DOM without changing the tab's disclosure owner. */
export async function transcriptVisibility(page: Page, visible: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => value ? "visible" : "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);
}
