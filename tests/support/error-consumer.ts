// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { ContentSession } from "../../protocol/content.ts";
import type { ServerFrame } from "../../protocol/messages.ts";
import type { Cdp } from "./cdp.ts";
import type { WsClient } from "./ws-client.ts";

export async function assertErrorConsumer(
  browser: Cdp,
  client: WsClient,
  sessionID: string,
): Promise<ContentSession> {
  const snapshot = await client.rpc<ContentSession>("session.get", {
    sessionID,
  });
  const state = snapshot.errorState;
  assert(state, "Normal session query has no identified observed state");
  assert(snapshot.error, "Expected a visible failure at this observed state");
  await browser.poll(
    `document.querySelector('.otk-session-error')?.dataset.errorRevision===${
      JSON.stringify(String(state.revision))
    }`,
  );
  assertEquals(
    await browser.evaluate(
      "document.querySelector('.otk-session-error-message').textContent",
    ),
    snapshot.error,
  );
  const content = await client.wait((frame) =>
    frame.t === "content" && frame.sessionID === sessionID &&
    frame.event.op === "session.error" &&
    frame.event.errorState?.revision === state.revision
  );
  assert(content.t === "content" && content.event.op === "session.error");
  assertEquals(content.event.errorState, state);
  assertEquals(content.event.error, snapshot.error);
  const indexState = (frame: ServerFrame) =>
    frame.t === "index.patch"
      ? frame.ops.find((op) =>
        op.op === "upsert" && op.entry.id === sessionID &&
        op.entry.attention.errorState?.revision === state.revision
      )
      : undefined;
  const indexFrame = await client.wait((frame) => !!indexState(frame));
  const index = indexState(indexFrame);
  assert(index?.op === "upsert");
  assertEquals(index.entry.attention.errorState, state);
  assertEquals(index.entry.attention.error, snapshot.error);
  assertEquals(
    await browser.evaluate(
      `document.querySelector('[data-session=${
        JSON.stringify(sessionID)
      }] [aria-label="Session error"]').title`,
    ),
    snapshot.error,
  );
  if (
    !await browser.evaluate(
      "document.querySelector('.otk-session-error-details').open",
    )
  ) await browser.click(".otk-session-error-details summary");
  await browser.poll(
    "document.querySelector('.otk-session-error-details').open",
  );
  assertEquals(
    await browser.evaluate(
      "[...document.querySelectorAll('.otk-error-observation-message')].map(el=>el.textContent)",
    ),
    state.observations.map((item) => item.message),
  );
  assertEquals(
    await browser.evaluate(
      "[...document.querySelectorAll('.otk-error-observation')].map(el=>el.dataset.source)",
    ),
    state.observations.map((item) => item.source),
  );
  const rendered = await browser.evaluate<string>(
    "document.querySelector('.otk-session-error-details').textContent",
  );
  for (const observation of state.observations) {
    if (observation.ref) assert(rendered.includes(observation.ref));
    if (observation.requestID) assert(rendered.includes(observation.requestID));
    if (observation.eventID) assert(rendered.includes(observation.eventID));
    if (observation.kind) assert(rendered.includes(observation.kind));
    if (observation.status) {
      assert(rendered.includes(String(observation.status)));
    }
    if (observation.source === "event") {
      assertEquals(observation.requestID, undefined);
    }
  }
  await browser.click(".otk-session-error-details summary");
  await browser.poll(
    "!document.querySelector('.otk-session-error-details').open",
  );
  for (const type of ["rawKeyDown", "char", "keyUp"]) {
    await browser.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      ...(type === "char" ? { text: "\r", unmodifiedText: "\r" } : {}),
    });
  }
  await browser.poll(
    "document.querySelector('.otk-session-error-details').open",
  );
  return snapshot;
}
export async function reloadErrorConsumer(
  browser: Cdp,
  client: WsClient,
  sessionID: string,
  expected: ContentSession,
): Promise<void> {
  const before = await browser.evaluate<number>(
    "(()=>{globalThis.errorReloadWitness='old-document';return performance.timeOrigin})()",
  );
  await browser.reload();
  await browser.poll(
    `globalThis.errorReloadWitness===undefined && performance.timeOrigin>${before}`,
  );
  await browser.poll(
    `document.querySelector('.otk-session-error')?.dataset.errorRevision===${
      JSON.stringify(String(expected.errorState?.revision))
    }`,
  );
  const reloaded = await assertErrorConsumer(browser, client, sessionID);
  assertEquals(
    reloaded.errorState,
    expected.errorState,
    "Reload changed the same established observed state",
  );
  assertEquals(reloaded.error, expected.error);
}
