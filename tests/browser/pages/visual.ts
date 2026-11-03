// SPDX-License-Identifier: LGPL-3.0-only
import type { Browser } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
/** Observe independent consumers before navigation; TestState retains cleanup. */
export async function independentPage(state: TestState, browser: Browser) {
  const context = await state.newContext(browser), errors: string[] = [];
  context.on("weberror", (event) => errors.push(String(event.error())));
  return { page: await context.newPage(), errors };
}
