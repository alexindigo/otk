// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { TurnTimingAccumulator } from "@otk/harness";
import { timingEvidence } from "../turn-timing.ts";
import { mapMessage } from "../map.ts";
import { OpencodeV1Adapter } from "../adapter.ts";
import { StreamBuffers } from "@otk/content";
import { cfg } from "../../../tests/support/config.ts";

Deno.test("V1 terminal page without an end does not install a recovering stream", async () => {
  const adapter = new OpencodeV1Adapter(cfg(), new StreamBuffers(), (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/session/s") {
      return Promise.resolve(
        Response.json({
          id: "s",
          directory: "/p",
          projectID: "p",
          title: "S",
          time: { created: 1, updated: 2 },
        }),
      );
    }
    return Promise.resolve(Response.json(
      path.endsWith("/message")
        ? [{
          info: {
            id: "m",
            sessionID: "s",
            role: "assistant",
            agent: "build",
            providerID: "p",
            modelID: "m",
            time: { created: 1 },
            error: {
              name: "MessageAbortedError",
              data: { message: "Interrupted" },
            },
          },
          parts: [{
            id: "p",
            messageID: "m",
            sessionID: "s",
            type: "text",
            text: "Interrupted body.",
          }],
        }]
        : [],
    ));
  });
  try {
    const page = await adapter.core.listMessages("opcv1-s", {});
    const message = page.items[0];
    assertEquals(message.role === "assistant" && message.terminal, true);
    assertEquals(
      message.parts[0].kind === "text" && message.parts[0].stream,
      undefined,
    );
  } finally {
    await adapter.core.stop();
  }
});
Deno.test("V1 separates model output from tool settlement and excludes question waits", () => {
  const owner = new TurnTimingAccumulator();
  owner.add(
    timingEvidence({ time: { created: 1000, completed: 5000 } }, [
      { type: "text", start: 1000, end: 1500 },
      { type: "tool", name: "read", start: 1400, end: 2000 },
      { type: "tool", name: "question", start: 2000, end: 5000 },
    ]),
  );
  assertEquals(owner.result(), {
    state: "known",
    start: 1000,
    end: 5000,
    workingMs: 1000,
  });
});
Deno.test("V1 aborted without a completion preserves terminality and unknown time", () => {
  const owner = new TurnTimingAccumulator();
  owner.add(
    timingEvidence({
      time: { created: 1000 },
      error: { name: "MessageAbortedError", data: {} },
    }, []),
  );
  assertEquals(owner.result(), {
    state: "unknown",
    start: 1000,
    terminal: true,
    reason: "missing-end",
  });
  const stopped = new TurnTimingAccumulator();
  const info = {
    id: "m",
    sessionID: "s",
    role: "assistant" as const,
    agent: "build",
    providerID: "p",
    modelID: "m",
    time: { created: 1000 },
    finish: "stop",
  };
  stopped.add(timingEvidence(info, []));
  assertEquals(stopped.result()?.state, "unknown");
  const mapped = mapMessage(info);
  assertEquals(mapped.role === "assistant" && mapped.terminal, true);
});
Deno.test("V1 later tool arguments extend model output beyond earlier text and tool dispatch", () => {
  const owner = new TurnTimingAccumulator();
  owner.add(
    timingEvidence({ time: { created: 1000, completed: 3000 } }, [
      { type: "text", end: 1200 },
      { type: "tool", name: "read", start: 1500, end: 1600 },
      { type: "tool", name: "read", start: 2000, end: 3000 },
    ]),
  );
  assertEquals(owner.result(), {
    state: "known",
    start: 1000,
    end: 3000,
    workingMs: 2000,
  });
});
Deno.test("V1 retry without a resumed request clock does not count the retry pause as work", () => {
  const owner = new TurnTimingAccumulator();
  owner.add(
    timingEvidence({ time: { created: 1000, completed: 100000 } }, [{
      type: "retry",
    }, { type: "text", start: 99000, end: 100000 }]),
  );
  assertEquals(owner.result(), {
    state: "unknown",
    start: 1000,
    end: 100000,
    terminal: true,
    reason: "incomplete-evidence",
  });
  const active = new TurnTimingAccumulator();
  active.add(timingEvidence({ time: { created: 1000 } }, [{ type: "retry" }]));
  assertEquals(active.result(), {
    state: "unknown",
    start: 1000,
    terminal: false,
    reason: "incomplete-evidence",
  });
});
