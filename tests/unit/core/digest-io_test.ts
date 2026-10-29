// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DigestReadGate } from "../../../core/digest/read-gate.ts";
import { test } from "../../support/resources.ts";

test("only an essential native permission blocked by background I/O requests preemption", async () => {
  let preemptions = 0;
  const gate = new DigestReadGate(() => {
    preemptions++;
  });
  const signal = new AbortController().signal;
  const background = await gate.acquire(signal, false);
  const essential = gate.acquire(signal, true);
  assertEquals(preemptions, 1);
  background();
  const release = await essential;
  const peer = gate.acquire(signal, true);
  assertEquals(
    preemptions,
    1,
    "An essential peer cannot retire an essential I/O owner",
  );
  release();
  (await peer)();
});

test("native I/O permission is bounded independently of the executing turn and prioritizes essential reads", async () => {
  const gate = new DigestReadGate(), entered: string[] = [];
  const signal = new AbortController().signal;
  const first = await gate.acquire(signal, false);
  entered.push("held");
  const background = gate.acquire(signal, false).then((release) => {
    entered.push("background");
    release();
    return "last";
  });
  const essential = gate.acquire(signal, true).then((release) => {
    entered.push("essential");
    release();
    return "next";
  });
  assertEquals(entered, ["held"]);
  first();
  assertEquals(await essential, "next");
  assertEquals(await background, "last");
  assertEquals(entered, ["held", "essential", "background"]);
});

test("cancelled queued I/O never starts and active permission is joined before reuse", async () => {
  const gate = new DigestReadGate();
  const active = new AbortController(), queued = new AbortController();
  let next = false, cancelled = false;
  const first = await gate.acquire(active.signal, false);
  const retired = gate.acquire(queued.signal, false).then((release) => {
    cancelled = true;
    release();
  });
  const retiredOutcome = Promise.allSettled([retired]);
  queued.abort();
  active.abort();
  const replacement = gate.acquire(new AbortController().signal, true).then(
    (release) => {
      next = true;
      release();
    },
  );
  await Promise.resolve();
  assertEquals(next, false);
  first();
  await replacement;
  assertEquals((await retiredOutcome)[0].status, "rejected");
  assertEquals(cancelled, false);
});
