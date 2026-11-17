// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { bounded } from "../../../tests/support/resources.ts";
import { cfg } from "../../../tests/support/config.ts";
import { Transcript } from "../transcript.ts";
import type { V2Client } from "../client.ts";

Deno.test("V2 retained failure anchor borrows caller cancellation without publishing a retired position", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const caller = new AbortController(), published: unknown[] = [];
  let anchorSignal: AbortSignal | undefined;
  const transcript = new Transcript({
    client: () =>
      ({
        failureFacts: () => ({ reason: "Native rejection" }),
      }) as unknown as V2Client,
    policy: cfg().messages,
    facts: () =>
      Promise.resolve({
        source: "fixture",
        contexts: {},
        metadata: { boundaries: [] },
      }),
    sequence: (_input, signal) => {
      anchorSignal = signal;
      entered.resolve();
      return new Promise((resolve, reject) => {
        release.promise.then(() => resolve(42));
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    content: (_id, op) => published.push(op),
    diagnostic() {},
    invalidated() {},
  });
  transcript.subscriptions("opcv2-ses_failure", 1);
  const work = transcript.executionFailure(
    {
      id: "evt_anchor",
      type: "session.execution.failed",
      created: 5,
      data: { sessionID: "ses_failure", error: { type: "provider" } },
    },
    "Failure",
    caller.signal,
  );
  const rejected = assertRejects(() => work, DOMException);
  try {
    await bounded("failure anchor entered", entered.promise);
    caller.abort();
    await bounded("failure anchor cancellation", rejected);
    assert(anchorSignal?.aborted);
    const retained = await transcript.requests.get(
      "opcv2-ses_failure",
      "failure:execution:evt_anchor",
    );
    assert(
      retained?.outcome,
      "The observation admitted before anchor acquisition remains retained",
    );
    assertEquals(retained.position?.basis, "pending");
    assertEquals(
      published,
      [],
      "A retired read cannot publish a final position",
    );
  } finally {
    release.resolve();
    await work.catch(() => {});
    await transcript.stop();
  }
});
