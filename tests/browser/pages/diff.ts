// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";

/** Hunk identity is independent of scroll frames, div siblings and diff mode. */
export function diffHunk(scope: string, oldStart: number, newStart: number) {
  return `${scope} .otk-diff-content[data-hunk-old-start="${oldStart}"][data-hunk-new-start="${newStart}"]`;
}
export async function expectDiffHunk(
  page: Page,
  selector: string,
  oldText: string,
  newText: string,
) {
  const hunk = page.locator(selector);
  await expect(hunk).toHaveCount(1);
  const lines = await hunk.locator(".otk-diff-text").allTextContents();
  expect(lines).toContain(oldText);
  expect(lines).toContain(newText);
}
