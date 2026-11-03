// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Locator, type Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";

export const contextMenu =
  ':popover-open [role="menu"][aria-label="Context menu"]';
export async function sessionContext(
  page: Page,
  selector: string,
  command?: string,
) {
  await page.locator(selector).click({ button: "right" });
  await expect(page.locator(contextMenu)).toBeVisible();
  if (command) {
    await page.locator(`${contextMenu} [data-context-command="${command}"]`)
      .click();
  }
}
export async function visibleOnScreen(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(() =>
    locator.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= 0 &&
        r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    })
  ).toBe(true);
}
export async function collapsed(page: Page) {
  await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(page.locator(".otk-right-panel")).toBeHidden();
  await expect(page.locator(".otk-right-rail")).toBeVisible();
}
export async function activity(
  state: TestState,
  id: string,
  action: "hold" | "release" | "freeze" | "thaw",
) {
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action,
    sessionID: id,
  });
}
