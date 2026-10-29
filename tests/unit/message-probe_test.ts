// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type { TranscriptOwner } from "@otk/client";
import type { ServerFrame } from "@otk/protocol";
import { createScaleProbe } from "../support/message-heap-consumer/probe.ts";

function fixture() {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "scaleMeasurements",
  );
  const messages = { old: { id: "old", parts: [] } };
  const owner = {
    state: { messagesByID: messages },
    pin: () => () => {},
    viewport() {},
  } as unknown as TranscriptOwner;
  const pending: (() => void)[] = [];
  const options = {
    target: { sidecarId: "test", sessionID: "s" },
    owner: () => owner,
    pane: () => null,
    observeLongTasks: () => ({ takeRecords: () => [], disconnect() {} }),
    settle: (run: () => void) => pending.push(run),
  };
  const probe = createScaleProbe(options);
  probe.armStream();
  const frame = {
    t: "content",
    sessionID: "s",
    event: { op: "part.blocks" },
  } as unknown as ServerFrame;
  return {
    messages,
    probe,
    frame,
    flush() {
      for (const run of pending.splice(0)) run();
    },
    stop() {
      probe.stop();
      if (previous) {
        Object.defineProperty(
          globalThis,
          "scaleMeasurements",
          previous,
        );
      } else Reflect.deleteProperty(globalThis, "scaleMeasurements");
    },
  };
}
Deno.test("stream work probe rejects a historical lookup and a whole-history copy", () => {
  const f = fixture();
  try {
    f.probe.receive(f.frame, () => {
      void f.messages.old.id;
    });
    f.flush();
    assert(f.probe.data.frames[0].historicalReads > 0);
    f.probe.receive(f.frame, () => {
      void { ...f.messages };
    });
    f.flush();
    assert(f.probe.data.frames[1].historicalReads > 0);
  } finally {
    f.stop();
  }
});
Deno.test("stream work probe admits isolated updates and preserves canonical property replacement", () => {
  const f = fixture();
  try {
    const current = { text: "new" };
    f.probe.receive(f.frame, () => {
      current.text += " source";
    });
    f.flush();
    assertEquals(f.probe.data.frames[0].historicalReads, 0);
    const replacement = { id: "old", parts: [] };
    f.messages.old = replacement;
    assertStrictEquals(f.messages.old, replacement);
    assertEquals(f.probe.data.historicalReads, 0);
  } finally {
    f.stop();
  }
});

Deno.test("stream work probe includes deferred binding reads before the consumer frame settles", async () => {
  const f = fixture();
  try {
    f.probe.receive(f.frame, () => {
      queueMicrotask(() => {
        void f.messages.old.parts;
      });
    });
    await Promise.resolve();
    f.flush();
    assert(f.probe.data.frames[0].historicalReads > 0);
  } finally {
    f.stop();
  }
});
