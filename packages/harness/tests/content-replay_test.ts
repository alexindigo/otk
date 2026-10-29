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

Deno.test("producer versions outlive demand epochs and invalidate only their actual authority scope", () => {
  let nonce = 0;
  const replay = new ContentReplay({
    replayops: 128,
    replaybytes: 4096,
    nonce: () => String(++nonce),
    emit() {},
  });
  const original = replay.version("a"), epoch = replay.clock("a");
  const a = replay.capture("a"), b = replay.capture("b");
  const changed = replay.invalidate("a");
  assertEquals(changed, {
    sessionID: "a",
    version: { generation: 0, revision: 1 },
  });
  assertThrows(() => a.seal(), Error, "capture-stale");
  assertEquals(b.seal().events, []);
  assertEquals(replay.version("b"), original);
  assertEquals(replay.clock("a").epoch === epoch.epoch, false);
  replay.release("a");
  replay.reset("b");
  replay.reset();
  assertEquals(replay.version("a"), changed.version);
  assertEquals(replay.version("b"), original);
  const held = replay.capture("b");
  const next = replay.invalidate();
  assertEquals(next, { version: { generation: 1, revision: 0 } });
  assertThrows(() => held.seal(), Error, "capture-stale");
  assertEquals(replay.version("a"), next.version);
  assertEquals(replay.version("b"), next.version);
  assertEquals(original, { generation: 0, revision: 0 });
  assertEquals(changed.version, { generation: 0, revision: 1 });
});
