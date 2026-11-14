// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";

/** Full failure facts may grow their owner; they cannot move its origin or clip. */
export async function expandedFailure(
  page: Page,
  selector: string,
  before: number[],
) {
  const geometry = await page.locator(selector).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const failures = [
      ...Array.from(el.querySelectorAll(".otk-feedback-status.has-failure")),
    ].map((status) => {
      const frame = status.getBoundingClientRect();
      const text = status.querySelector(".otk-feedback-text")!
        .getBoundingClientRect();
      return frame.bottom + 1 >= text.bottom && box.bottom + 1 >= frame.bottom;
    });
    return { box: [box.x, box.y, box.width, box.height], failures };
  });
  expect(geometry.box.slice(0, 3)).toEqual(before.slice(0, 3));
  expect(geometry.box[3]).toBeGreaterThanOrEqual(before[3]);
  expect(geometry.failures.length).toBeGreaterThan(0);
  expect(geometry.failures.every(Boolean)).toBe(true);
}
