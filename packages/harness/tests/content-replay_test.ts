// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { ContentReplay } from "../content-replay.ts";

Deno.test("content captures seal one clock, isolate attention and reject overflowing baselines", () => {
  const emitted: unknown[] = [];
  let nonce = 0;
  const replay = new ContentReplay({
    replayops: 2,
    replaybytes: 4096,
    nonce: () => `epoch-${++nonce}`,
    emit: (...args) => emitted.push(args),
  });
  const capture = replay.capture("s");
  replay.publish("s", { op: "todo.set", items: [] });
  replay.publish("s", {
    op: "permission.remove",
    requestID: "r",
    sessionID: "s",
  });
  const sealed = capture.seal();
  assertEquals(sealed.events.length, 1);
  assertEquals(sealed.clock.seq, 1);
  capture.release();
  capture.release();
  const overflow = replay.capture("s");
  for (let n = 0; n < 10000; n++) {
    replay.publish("s", { op: "todo.set", items: [] });
  }
  assertThrows(() => overflow.seal(), Error, "capture-overflow");
  overflow.release();
  assertEquals(emitted.length, 10002);
  const old = replay.clock("s");
  replay.release("s");
  assertEquals(replay.clock("s").seq, 0);
  assertEquals(replay.clock("s").epoch === old.epoch, false);
});

Deno.test("one oversized UTF-8 operation invalidates and releases its capture payload", () => {
  const replay = new ContentReplay({
    replayops: 128,
    replaybytes: 256,
    nonce: () => crypto.randomUUID(),
    emit() {},
  });
  const capture = replay.capture("s");
  replay.publish("s", { op: "session.error", error: "界".repeat(1000) });
  assertThrows(() => capture.seal(), Error, "capture-overflow");
  const reset = replay.capture("s");
  replay.reset("s");
  assertThrows(() => reset.seal(), Error, "capture-stale");
});
