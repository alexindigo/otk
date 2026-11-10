// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import type { ContentSession } from "@otk/protocol";
import type { Page } from "@playwright/test";

async function errorConsumer(
  state: TestState,
  page: Page,
  frames: Awaited<ReturnType<typeof wire>>,
  id: string,
) {
  const snapshot = await state.product("session.get", { sessionID: id });
  expect(snapshot.error).toBeTruthy();
  expect(snapshot.errorState).toBeDefined();
  const current = snapshot.errorState!;
  await expect(page.locator(".otk-session-error")).toHaveAttribute(
    "data-error-revision",
    String(current.revision),
  );
  // Both exposed diagnostics must agree with the same normal query snapshot.
  await expect.poll(() =>
    frames.received.some((frame) => {
      if (frame.t !== "content" || frame.sessionID !== id) return false;
      const event = frame.event as {
        op: string;
        errorState?: unknown;
        error?: string;
      };
      return event.op === "session.error" &&
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
    >()).entries.find((entry) => entry?.id === id)?.attention.errorState
  ).toEqual(current);
  const entry = (await state.observe<
    { entries: { id: string; attention: { error?: string } }[] }
  >()).entries.find((entry) => entry?.id === id)!;
  expect(entry.attention.error).toBe(snapshot.error);
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
  await expect(page.locator(".otk-session-error-message")).toHaveText(
    current.observations.some((item) => item.source === "event")
      ? "The agent reported a session failure. Review the conversation before continuing"
      : current.observations[0].failure?.code === "native.unknown"
      ? "Checking whether this finished"
      : "Could not finish this action. Try again",
  );
  return snapshot;
}
async function reload(
  state: TestState,
  page: Page,
  frames: Awaited<ReturnType<typeof wire>>,
  id: string,
  expected: ContentSession,
) {
  const origin = await page.evaluate(() => performance.timeOrigin);
  await page.reload();
  expect(await page.evaluate(() => performance.timeOrigin)).toBeGreaterThan(
    origin,
  );
  await expect(page.locator(".otk-session-error")).toHaveAttribute(
    "data-error-revision",
    String(expected.errorState!.revision),
  );
  const reloaded = await errorConsumer(state, page, frames, id);
  expect(reloaded.errorState).toEqual(expected.errorState);
  expect(reloaded.error).toBe(expected.error);
}

for (const kind of ["http", "event", "late-http"] as const) {
  test.describe(kind, () => {
    test.use({
      profile: kind === "http"
        ? "transport-errors-http"
        : kind === "late-http"
        ? "transport-errors-late"
        : "isolated",
    });
    test(
      `transport.error-${kind}`,
      { tag: ["@transport", "@isolated"] },
      async ({ isolatedState: state, page }, info) => {
        const session = await state.native<{ id: string; nativeID: string }>(
          "/session",
          "POST",
          { title: `${kind} failure` },
        );
        const frames = await wire(page);
        await openSession(state, page, session.id);
        const draft = `${kind} failure keeps this draft`;
        await page.locator("textarea[name=prompt]").fill(draft);
        if (kind === "event") {
          if (info.project.name === "oc-2.2.6") {
            // V2 admits the prompt, then reports execution failure on the feed.
            await state.native(`/session/${session.id}/prompt_async`, "POST", {
              parts: [{ type: "text", text: "Fail at native selection" }],
              agent: "missing-event-only-agent",
            });
          } else {await expect(
              state.native(`/session/${session.id}/shell`, "POST", {
                command: "echo should-not-run",
                agent: "missing-event-only-agent",
              }),
            ).rejects.toThrow("500");}
        } else {
          if (kind === "late-http") {
            await state.controller.call("scenario", {
              lease: state.lease.lease,
              action: "hold",
            });
          }
          await state.controller.call("scenario", {
            lease: state.lease.lease,
            action: "fail",
            sessionID: session.nativeID,
          });
        }
        await expect(page.locator(".otk-session-error")).toBeVisible();
        let snapshot = await errorConsumer(state, page, frames, session.id);
        expect(snapshot.errorState!.observations).toHaveLength(1);
        const observation = snapshot.errorState!.observations[0];
        expect(observation.source).toBe(kind === "http" ? "http" : "event");
        if (kind === "http") {
          expect(observation.status).toBe(503);
          expect(observation.ref).toBe("proxy-http-only");
          expect(
            (await state.observe<{ transport: { effects: number } }>())
              .transport.effects,
          ).toBe(1);
        } else {
          expect(observation.requestID).toBeUndefined();
          expect(observation.eventID).toBeTruthy();
          expect(snapshot.error).toContain(
            kind === "event"
              ? "missing-event-only-agent"
              : "missing-late-http-agent",
          );
        }
        if (kind === "late-http") {
          await expect.poll(async () =>
            (await state.observe<{ transport: { entered: boolean } }>())
              .transport.entered
          ).toBe(true);
          await state.controller.call("scenario", {
            lease: state.lease.lease,
            action: "release",
          });
          await expect.poll(async () =>
            (await state.product("session.get", { sessionID: session.id }))
              .errorState!.observations.length
          ).toBe(2);
          const enriched = await errorConsumer(state, page, frames, session.id);
          expect(enriched.error).toBe(snapshot.error);
          expect(enriched.errorState!.revision).toBeGreaterThan(
            snapshot.errorState!.revision,
          );
          const http = enriched.errorState!.observations.find((item) =>
            item.source === "http"
          )!;
          expect(http.ref).toBeTruthy();
          expect(http.status).toBe(500);
          expect(http.failure).toBeDefined();
          snapshot = enriched;
        }
        await expect(page.locator("textarea[name=prompt]")).toHaveValue(draft);
        expect((await state.observe<{ requests: unknown[] }>()).requests)
          .toEqual([]);
        await reload(state, page, frames, session.id, snapshot);
      },
    );
  });
}
