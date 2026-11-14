// SPDX-License-Identifier: LGPL-3.0-only
import { errors, expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { TestState } from "../fixtures/test-state.ts";

/** Explicit fixture-history observation, independent of OTK and the lossy V1 facade. */
export async function nativeHistoryCount(
  state: TestState,
  sessionID: string,
): Promise<number> {
  if (!state.controller.info!.version.startsWith("2.")) {
    return (await state.native<unknown[]>(`/session/${sessionID}/message`))
      .length;
  }
  const info = state.controller.info!;
  const registration = JSON.parse(
    await readFile(info.root + "/discovery/opencode/service.json", "utf8"),
  );
  const headers: Record<string, string> = {};
  if (registration.password !== undefined) {
    headers.authorization = "Basic " +
      Buffer.from("opencode:" + registration.password).toString("base64");
  }
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const url = new URL(
      `/api/session/${
        encodeURIComponent(sessionID.replace(/^opcv2-/, ""))
      }/message`,
      info.nativeUrl,
    );
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    else url.searchParams.set("order", "asc");
    const response = await fetch(url, { headers });
    expect(response.ok).toBe(true);
    const page = await response.json() as {
      data: { id: string }[];
      cursor: { next?: string | null };
    };
    for (const row of page.data) {
      expect(seen.has(row.id)).toBe(false);
      seen.add(row.id);
    }
    const next = page.cursor.next ?? undefined;
    if (next) expect(next).not.toBe(cursor);
    cursor = next;
  } while (cursor);
  return seen.size;
}

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
