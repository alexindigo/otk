// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { MessageRecovery } from "../recovery.ts";
import type { NativeMessage } from "../messages.ts";
const raw = (id: string): NativeMessage => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "fake", id: "model" },
  content: [],
  time: { created: 1, completed: 2 },
});
Deno.test("V2 missing-seed recovery never rearms from deltas and terminal authority is a separate replacement", async () => {
  let reads = 0;
  const gates = [
      Promise.withResolvers<NativeMessage>(),
      Promise.withResolvers<NativeMessage>(),
    ],
    states: string[] = [],
    emitted: boolean[] = [],
    first = Promise.withResolvers<void>(),
    emittedFirst = Promise.withResolvers<void>(),
    second = Promise.withResolvers<void>(),
    ready = Promise.withResolvers<void>();
  const r = new MessageRecovery({
    concurrency: 1,
    pending: 4,
    wanted: () => true,
    read: () => {
      const index = reads++;
      if (index === 0) first.resolve();
      if (index === 1) second.resolve();
      return gates[index].promise;
    },
    emit: (_s, _m, _p, _g, terminal) => {
      emitted.push(terminal);
      if (!terminal) emittedFirst.resolve();
    },
    state: (_s, _m, _p, _g, state) => {
      states.push(state);
      if (state === "ready") ready.resolve();
    },
    reconcile: () => {},
    failed: () => {},
  });
  r.touch("session", "message", "text:0");
  await first.promise;
  assertEquals(reads, 1);
  gates[0].resolve(raw("message"));
  await emittedFirst.promise;
  for (let i = 0; i < 100; i++) r.touch("session", "message", "text:0");
  assertEquals(reads, 1);
  r.terminal("session", "message");
  await second.promise;
  assertEquals(reads, 2);
  gates[1].resolve(raw("message"));
  await ready.promise;
  await r.stop();
  assertEquals(emitted, [false, true]);
  assert(states.includes("recovering"));
});
Deno.test("V2 recovery admission bounds reads, joins cancellation, and collapses fine-key overflow", async () => {
  let active = 0, max = 0, reads = 0, reconciles = 0;
  const signals: AbortSignal[] = [];
  const admitted = Promise.withResolvers<void>();
  const r = new MessageRecovery({
    concurrency: 2,
    pending: 3,
    wanted: () => true,
    read: (_s, _m, signal) => {
      reads++;
      active++;
      max = Math.max(max, active);
      signals.push(signal);
      if (reads === 2) admitted.resolve();
      return new Promise<NativeMessage>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          active--;
          reject(signal.reason);
        }, { once: true });
      });
    },
    emit: () => {},
    state: () => {},
    reconcile: () => {
      reconciles++;
    },
    failed: () => {},
  });
  r.touch("session", "m1", "p1");
  r.touch("session", "m2", "p2");
  r.touch("session", "m3", "p3");
  await admitted.promise;
  assertEquals(reads, 2);
  r.touch("session", "m4", "p4");
  assertEquals(reconciles, 1);
  assertEquals(r.scoped("session"), true);
  assert(signals.every((s) => s.aborted));
  r.touch("session", "m5", "p5");
  await r.stop();
  assertEquals(max, 2);
  assertEquals(active, 0);
  assertEquals(reads, 2);
});
