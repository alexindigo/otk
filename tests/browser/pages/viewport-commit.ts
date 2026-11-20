// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";

interface Commit {
  actual: number;
  extent: number;
  committed: number;
  end: number;
}
export function assertViewportEnd(value: Commit) {
  expect(Math.abs(value.actual - value.committed)).toBeLessThan(1);
  expect(Math.abs(value.extent - value.end)).toBeLessThan(1);
  expect(Math.abs(value.committed - value.end)).toBeLessThan(1);
}
/** WP1/WP8: the position owner's published extents, not a footer's box, define end. */
export async function expectViewportEnd(page: Page) {
  await expect.poll(async () => {
    const value = await page.locator(".otk-messages").evaluate((pane) => {
      const owner = document.querySelector(
        `[role="scrollbar"][aria-controls="${
          CSS.escape(pane.id)
        }"][aria-orientation="vertical"]`,
      )!;
      return {
        actual: pane.scrollTop,
        extent: pane.scrollHeight - pane.clientHeight,
        committed: Number(owner.getAttribute("aria-valuenow")),
        end: Number(owner.getAttribute("aria-valuemax")),
      };
    });
    try {
      assertViewportEnd(value);
      return true;
    } catch {
      return false;
    }
  }).toBe(true);
}
