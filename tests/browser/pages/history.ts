// SPDX-License-Identifier: LGPL-3.0-only
import { errors, expect, type Locator, type Page } from "@playwright/test";

/** Automatic reserve and manual paging share one exact acquisition boundary. */
export async function acquireOlderHistory(
  page: Page,
  total: number,
  older: Locator = page.locator(".otk-load-older"),
) {
  const acquired = () =>
    page.locator(".otk-message-flow").getAttribute("data-message-count").then(
      Number,
    );
  await expect.poll(acquired).toBeGreaterThan(0);
  let count = await acquired();
  while (count < total) {
    const before = count;
    if (await older.count()) {
      try {
        await older.click({ timeout: 1000 });
      } catch (error) {
        // The reserve can reach the boundary between observing and clicking the
        // control. Accept only that exact outcome, never another click failure.
        if (
          !(error instanceof errors.TimeoutError) || await acquired() !== total
        ) {
          throw error;
        }
      }
    }
    await expect.poll(acquired).toBeGreaterThan(before);
    count = await acquired();
  }
  await expect.poll(acquired).toBe(total);
}
