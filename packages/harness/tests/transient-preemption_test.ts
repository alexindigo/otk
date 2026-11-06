// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DigestScheduler, ReadAdmission } from "@otk/harness";
import { cfg } from "../../../tests/support/config.ts";
import { test } from "../../../tests/support/resources.ts";

test("spare native I/O capacity admits an urgent read without retiring its peer", async () => {
  let preempted = false;
  const admission = new ReadAdmission(() => {
    preempted = true;
  }, 2);
  const signal = new AbortController().signal;
  const optional = await admission.acquire(signal, false);
  const urgent = await admission.acquire(signal, true);
  assertEquals(preempted, false);
  urgent();
  optional();
});

test("essential native admission preempts and retries a revocable transient read", async () => {
  const scheduler = new DigestScheduler({
    ...cfg().digest,
    cpu: 1,
    memoryreserve: 1,
  }, {
    freeMemory: () => 100,
    sleep: () => Promise.resolve(),
  });
  const admission = new ReadAdmission();
  const source = Promise.withResolvers<void>();
  const owner = new AbortController();
  let attempts = 0, entered = false, aborted = 0, joined = false;
  let urgentDone = false, value: string | undefined;
  const optional = scheduler.execute(
    async (signal, turn) => {
      attempts++;
      const release = await turn.wait(
        admission.acquire(signal, false, () => scheduler.interruptIO(signal)),
      );
      entered = true;
      const body = Promise.withResolvers<void>();
      const abort = () => {
        aborted++;
        body.reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      void source.promise.then(body.resolve);
      try {
        // Permission ownership, not a transient wait marker, identifies the
        // read that must settle before essential admission can proceed.
        await turn.wait(body.promise);
        return "scalar result";
      } finally {
        signal.removeEventListener("abort", abort);
        await turn.join(body.promise.catch(() => {}));
        joined = true;
        release();
      }
    },
    owner.signal,
    "visible",
    true,
  ).then((result) => {
    value = result;
  });
  const outcomes = Promise.allSettled([optional]);
  try {
    while (!entered) {
      await scheduler.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const urgent = scheduler.execute(async (signal, turn) => {
      const release = await turn.wait(admission.acquire(signal, true));
      assertEquals(
        joined,
        true,
        "cancelled native settlement joins before I/O reuse",
      );
      release();
      urgentDone = true;
    }, owner.signal);
    void urgent.catch(() => {}); // cleanup observes a deliberately failing red too
    const deadline = Date.now() + 500;
    while (!urgentDone && Date.now() < deadline) {
      await scheduler.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assertEquals(
      urgentDone,
      true,
      "urgent identity validation must pass held optional I/O",
    );
    assertEquals(
      value,
      undefined,
      "preemption must not invent an optional result",
    );
    source.resolve();
    while (value === undefined) {
      await scheduler.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await urgent;
    assertEquals(value, "scalar result");
    assertEquals(attempts, 2);
    assertEquals(aborted, 1);
  } finally {
    source.resolve();
    owner.abort();
    await scheduler.stop();
    await outcomes;
  }
});
