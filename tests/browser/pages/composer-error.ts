// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import type { wire } from "../fixtures/wire.ts";
import type {
  ContentOp,
  ContentSession,
  SessionErrorState,
} from "@otk/protocol";
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
  const observation = errorObservation(current)!;
  const retained = observation.failure?.facts?.record;
  const recordIDs = [
    ...new Set(
      current.observations.flatMap((o) =>
        o.failure?.facts?.record ? [o.failure.facts.record.messageID] : []
      ),
    ),
  ];
  const sink = retained
    ? page.locator(
      `[data-message="${retained.messageID}"] [data-native-record$="/request-failure"]`,
    )
    : page.locator(".otk-session-error-message");
  if (retained) {
    await expect(sink).toHaveCount(1);
    const rows = page.locator('[data-native-record$="/request-failure"]');
    await expect(rows).toHaveCount(2);
    expect(recordIDs).toHaveLength(2);
    for (const report of current.observations) {
      const facts = report.failure?.facts;
      expect(facts?.record).toBeDefined();
      const record = page.locator(
        `[data-message="${
          facts!.record!.messageID
        }"] [data-native-record$="/request-failure"]`,
      );
      await expect(record).toContainText(facts?.reason ?? report.message);
      if (report.source === "http") {
        await expect(record).toContainText("HTTP 500");
      } else await expect(record).not.toContainText("HTTP 500");
    }
    const arrival = [
      ...new Set(
        frames.received.flatMap((frame) => {
          const event = frame.event as ContentOp | undefined;
          return frame.t === "content" && frame.sessionID === id &&
              event?.op === "message.upsert" &&
              recordIDs.includes(event.message.id)
            ? [event.message.id]
            : [];
        }),
      ),
    ];
    expect(arrival).toHaveLength(2);
    expect(
      await rows.evaluateAll((nodes) =>
        nodes.map((node) =>
          node.closest("article")?.getAttribute("data-message")
        )
      ),
    ).toEqual(arrival);
    const composerOwnsPointer = current.observations.some((report) =>
      !report.cleared && report.failure?.facts?.origin === "composer"
    );
    const pointer = page.locator(".otk-session-error");
    await expect(pointer).toHaveCount(composerOwnsPointer ? 0 : 1);
    if (!composerOwnsPointer) {
      await expect(pointer).toHaveAttribute(
        "data-error-revision",
        String(current.revision),
      );
      await expect(
        pointer.getByRole("button", {
          name: "See the session error",
          exact: true,
        }),
      )
        .toBeVisible();
      await expect(pointer).not.toContainText(
        observation.failure?.facts?.reason ?? observation.message,
      );
    }
  } else {
    await expect(page.locator(".otk-session-error")).toHaveAttribute(
      "data-error-revision",
      String(current.revision),
    );
  }
  await expect(sink).toContainText(
    observation.failure?.facts?.reason ?? observation.message,
  );
  await expect(sink.locator(`a[href="#/local/${id}"]`)).toHaveCount(0);
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
  const rendered = retained
    ? await page.locator('[data-native-record$="/request-failure"]')
      .allTextContents()
    : [await sink.textContent()];
  for (const observation of current.observations) {
    for (
      const identity of [
        observation.ref,
        observation.requestID,
        observation.eventID,
      ]
    ) if (identity) expect(rendered.join("\n")).not.toContain(identity);
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
  const retained = errorObservation(snapshot.errorState!)?.failure?.facts
    ?.record;
  if (retained) {
    await expect(page.locator('[data-native-record$="/request-failure"]'))
      .toHaveCount(2);
  } else {await expect(page.locator(".otk-session-error")).toHaveAttribute(
      "data-error-revision",
      String(snapshot.errorState!.revision),
    );}
  const current = await composerError(state, page, frames, id);
  expect(current.errorState).toEqual(snapshot.errorState);
  expect(current.error).toBe(snapshot.error);
}
