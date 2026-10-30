// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { type ContentSession, sessionErrorObservation } from "@otk/protocol";
import { presentFailure } from "@otk/client";
import { waitFor } from "./opencode.ts";
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
    sessionErrorObservation(state)?.failure
      ? presentFailure(sessionErrorObservation(state)!.failure!).text
      : "The agent reported a session failure. Review the conversation before continuing",
  );
  const content = await client.wait((frame) =>
    frame.t === "content" && frame.sessionID === sessionID &&
    frame.event.op === "session.error" &&
    frame.event.errorState?.revision === state.revision
  );
  assert(content.t === "content" && content.event.op === "session.error");
  assertEquals(content.event.errorState, state);
  assertEquals(content.event.error, snapshot.error);
  const index = await waitFor(
    () => client.entry(sessionID),
    (value) => value?.attention.errorState?.revision === state.revision,
  );
  assertEquals(index!.attention.errorState, state);
  assertEquals(index!.attention.error, snapshot.error);
  assertEquals(
    await browser.evaluate(
      `document.querySelector('[data-session=${
        JSON.stringify(sessionID)
      }] [aria-label="Session error"]').title`,
    ),
    "The agent reported a session failure",
  );
  assertEquals(
    await browser.evaluate(
      "document.querySelector('.otk-session-error-details')",
    ),
    null,
  );
  const rendered = await browser.evaluate<string>(
    "document.querySelector('.otk-session-error').textContent",
  );
  for (const observation of state.observations) {
    if (observation.ref) assert(!rendered.includes(observation.ref));
    if (observation.requestID) {
      assert(!rendered.includes(observation.requestID));
    }
    if (observation.eventID) assert(!rendered.includes(observation.eventID));
    if (observation.source === "event") {
      assertEquals(observation.requestID, undefined);
    }
  }
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
