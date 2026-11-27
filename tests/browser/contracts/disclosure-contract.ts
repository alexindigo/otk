// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../fixtures/evidence.ts";

/** The label rows share one pointer, keyboard, region and focus contract. */
export async function labelDisclosure(trigger: Locator): Promise<Locator> {
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAttribute("aria-controls", /\S+/);
  const id = (await trigger.getAttribute("aria-controls"))!;
  const region = trigger.page().locator(`[id=${JSON.stringify(id)}]`);
  await expect(region).toHaveAttribute("role", "group");
  await expect(region).toHaveAttribute("hidden", "");
  const glyph = trigger.locator(".otk-disclosure-icon");
  await glyph.click();
  await expect(trigger).toBeFocused();
  await expect(region).toBeVisible();
  await trigger.locator(".otk-disclosure-label").click();
  await expect(region).toHaveAttribute("hidden", "");
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
  return region;
}
