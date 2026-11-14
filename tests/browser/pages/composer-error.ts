// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import type { wire } from "../fixtures/wire.ts";
import type { ContentSession, SessionErrorState } from "@otk/protocol";
import { messages, prompt } from "./composer.ts";

/** The test observes native-vs-current HTTP authority independently of the UI. */
export function errorObservation(state: SessionErrorState) {
  const active = state.observations.filter((item) => !item.cleared);
  return active.find((item) => item.source === "event") ??
    active.find((item) =>
      item.source === "http" && item.requestID === state.currentRequestID
    ) ?? active[0];
}

/** V2 validates these inputs before admitting a native execution. It must not
 * fabricate a durable session error or corrupt another client's current draft. */
export async function rejectedComposerInput(
  state: TestState,
  page: Page,
  id: string,
  error: string,
) {
  await expect.poll(async () =>
    (await state.observe<{ operation: { settled: boolean; error?: string } }>())
      .operation
  )
    .toMatchObject({
      settled: true,
      failure: { code: error },
    });
  await expect(prompt(page)).toHaveValue("keep this draft");
  await expect(page.locator(".otk-session-error")).toHaveCount(0);
  expect((await state.product("session.get", { sessionID: id })).error)
    .toBeUndefined();
  expect(await messages(state, id)).toHaveLength(0);
  await page.reload();
  await expect(prompt(page)).toBeVisible();
  await expect(page.locator(".otk-session-error")).toHaveCount(0);
  expect((await state.product("session.get", { sessionID: id })).error)
    .toBeUndefined();
  expect(await messages(state, id)).toHaveLength(0);
  expect((await state.observe<{ requests: unknown[] }>()).requests)
    .toHaveLength(0);
}

/** Query, content stream, index and visible sink must identify one error state. */
export async function composerError(
  state: TestState,
  page: Page,
  frames: Awaited<ReturnType<typeof wire>>,
  id: string,
) {
  await expect.poll(async () =>
    (await state.product("session.get", { sessionID: id })).errorState
      ?.observations.some((o) => o.source === "http")
  ).toBe(true);
  const snapshot = await state.product("session.get", { sessionID: id }),
    current = snapshot.errorState!;
  expect(snapshot.error).toBeTruthy();
  expect(
    current.observations.some((o) =>
      o.source === "http" && o.status === 500 && o.ref
    ),
  ).toBe(true);
  await expect(page.locator(".otk-session-error")).toHaveAttribute(
    "data-error-revision",
    String(current.revision),
  );
  const observation = errorObservation(current)!;
  await expect(page.locator(".otk-session-error-message")).toContainText(
    observation.failure?.facts?.reason ?? observation.message,
  );
  await expect(page.locator(".otk-session-error-message a")).toHaveAttribute(
    "href",
    `#/local/${id}`,
  );
  await expect.poll(() =>
    frames.received.some((frame) => {
      const event = frame.event as {
        op?: string;
        errorState?: unknown;
        error?: string;
      } | undefined;
      return frame.t === "content" && frame.sessionID === id &&
        event?.op === "session.error" &&
        JSON.stringify(event.errorState) === JSON.stringify(current) &&
        event.error === snapshot.error;
    })
  ).toBe(true);
  await expect.poll(async () =>
    (await state.observe<
      {
        entries: {
          id: string;
          attention: { errorState?: unknown; error?: string };
        }[];
      }
    >()).entries.find((entry) => entry?.id === id)?.attention
  ).toMatchObject({ errorState: current, error: snapshot.error });
  await expect(
    page.locator(`[data-session="${id}"] [aria-label="Session error"]`),
  ).toHaveAttribute("title", "The agent reported a session failure");
  await expect(page.locator(".otk-session-error-details")).toHaveCount(0);
  const rendered = await page.locator(".otk-session-error").textContent();
  for (const observation of current.observations) {
    for (
      const identity of [
        observation.ref,
        observation.requestID,
        observation.eventID,
      ]
    ) if (identity) expect(rendered).not.toContain(identity);
    if (observation.source === "event") {
      expect(observation.requestID).toBeUndefined();
    }
  }
  return snapshot;
}
export async function reloadComposerError(
  state: TestState,
  page: Page,
  frames: Awaited<ReturnType<typeof wire>>,
  id: string,
  snapshot: ContentSession,
) {
  const origin = await page.evaluate(() => performance.timeOrigin);
  await page.reload();
  expect(await page.evaluate(() => performance.timeOrigin)).toBeGreaterThan(
    origin,
  );
  await expect(page.locator(".otk-session-error")).toHaveAttribute(
    "data-error-revision",
    String(snapshot.errorState!.revision),
  );
  const current = await composerError(state, page, frames, id);
  expect(current.errorState).toEqual(snapshot.errorState);
  expect(current.error).toBe(snapshot.error);
}
