// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
/** A fixed source must reacquire its capabilities, not just revisit the same hash. */
export async function fixedContent(
  state: TestState,
  page: Page,
  sessionID: string,
  name: string,
) {
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
    sessionID: "tstv1-" + name,
  });
  await page.goto(state.url + "/#/local/" + sessionID);
  await page.reload();
  await expect(page.locator(".otk-session-view")).toBeVisible();
  await page.evaluate(() =>
    document.fonts.ready.then(() =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    )
  );
}
