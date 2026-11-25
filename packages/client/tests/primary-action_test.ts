// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  CommandHub,
  createPrimaryAction,
  promptUnavailable,
  stopUnavailable,
} from "@otk/client";

Deno.test("composer mode follows only draft and session activity", async () => {
  const { composerMode } = await import("../primary-action.ts") as Record<
    string,
    unknown
  >;
  const mode = composerMode as (
    facts: { blank: boolean; unstarted: number; running: boolean },
  ) => string;
  for (const blank of [false, true]) {
    for (const unstarted of [0, 1]) {
      for (const running of [false, true]) {
        assertEquals(
          mode({ blank, unstarted, running }),
          blank && (unstarted > 0 || running) ? "stop" : "send",
        );
      }
    }
  }
});

Deno.test("Stop has its own availability and captures the primary mode at invocation", async () => {
  const ready = {
    active: true,
    suspended: false,
    connected: true,
    supported: true,
  };
  assertEquals(stopUnavailable(ready), undefined);
  assertEquals(
    stopUnavailable({ ...ready, active: false }),
    "Composer is no longer active",
  );
  assertEquals(
    stopUnavailable({ ...ready, suspended: true }),
    "Answer the pending request first",
  );
  assertEquals(
    stopUnavailable({ ...ready, connected: false }),
    "Reconnect to stop",
  );
  assertEquals(
    stopUnavailable({ ...ready, supported: false }),
    "Stopping is not supported here",
  );
  const gate = Promise.withResolvers<void>();
  let mode: "send" | "stop" = "stop";
  const calls: ("send" | "stop" | undefined)[] = [];
  const primary = createPrimaryAction({
    mode: () => mode,
    label: () => mode,
    unavailable: () => undefined,
    pendingReason: (current) => current === "stop" ? "Stopping" : "Sending",
    run: async (_, captured) => {
      await gate.promise;
      calls.push(captured);
    },
  });
  const stopping = primary.invoke();
  assertEquals(primary.state.reason, "Stopping");
  mode = "send";
  assertEquals(primary.state.available, true);
  gate.resolve();
  await stopping;
  assertEquals(calls, ["stop"]);
});

Deno.test("primary action stays visible, reports actual blockers and admits no unavailable intent", async () => {
  const ready = {
    active: true,
    suspended: false,
    connected: true,
    supported: true,
    content: true,
    chips: [],
  };
  const cases = [
    [{ content: false }, "Write a message"],
    [{ connected: false }, "Reconnect to send"],
    [{ supported: false }, "Sending is not supported here"],
    [{ suspended: true }, "Answer the pending request first"],
    [{ active: false }, "Composer is no longer active"],
    [{ chips: [{ pending: true }] }, "Waiting for attachment"],
    [
      { chips: [{ error: "upload rejected" }] },
      "Remove or retry the failed attachment",
    ],
  ] as const;
  let calls = 0;
  for (const [facts, reason] of cases) {
    const owner = createPrimaryAction({
      label: () => "Send",
      unavailable: () => promptUnavailable({ ...ready, ...facts }),
      pendingReason: "Sending",
      run: () => {
        calls++;
      },
    });
    assertEquals(owner.state, {
      label: "Send",
      visible: true,
      available: false,
      pending: false,
      reason,
    });
    await owner.invoke();
    assertEquals(calls, 0);
  }
  assertEquals(promptUnavailable(ready), undefined);
});

Deno.test("primary action reserves pending synchronously across click, Enter and commands", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  let reason: string | undefined = undefined;
  const owner = createPrimaryAction<string>({
    label: () => "Answer",
    unavailable: () => reason,
    pendingReason: "Sending answer",
    run: async (intent) => {
      assertEquals(intent, "click");
      calls++;
      await gate.promise;
    },
  });
  const first = owner.invoke("click");
  assertEquals(owner.state.pending, true);
  assertEquals(owner.state.reason, "Sending answer");
  assertEquals(owner.state.visible, true);
  await owner.invoke("Enter");
  await owner.invoke("command");
  assertEquals(calls, 1);
  reason = "Reconnect to answer";
  gate.resolve();
  await first;
  assertEquals(owner.state.reason, reason);
  assertEquals(owner.permitted(), false);
  await owner.invoke("offline command");
  assertEquals(calls, 1);
});

Deno.test("primary preparation rechecks current eligibility and preserves refusal/retry", async () => {
  const gate = Promise.withResolvers<void>();
  let connected = true, effects = 0;
  const owner = createPrimaryAction({
    label: () => "Send",
    unavailable: () => connected ? undefined : "Reconnect to send",
    pendingReason: "Sending",
    run: async () => {
      await gate.promise;
      if (owner.permitted()) effects++;
    },
  });
  const preparing = owner.invoke();
  connected = false;
  gate.resolve();
  await preparing;
  assertEquals(effects, 0);
  connected = true;
  await owner.invoke();
  assertEquals(effects, 1);
});

Deno.test("primary command invocation uses the same live owner as pointer and Enter", async () => {
  const hub = new CommandHub();
  const gate = Promise.withResolvers<void>();
  let reason: string | undefined = "Write a message", effects = 0;
  const primary = createPrimaryAction({
    label: () => "Send",
    unavailable: () => reason,
    pendingReason: "Sending",
    run: async () => {
      effects++;
      await gate.promise;
    },
  });
  hub.register({
    id: "probe.primary",
    title: "Send",
    category: "Probe",
    enabled: () => primary.state.available,
    run: () => primary.invoke(),
  });
  await assertRejects(() => hub.run("probe.primary"), Error, "unavailable");
  assertEquals(effects, 0);
  reason = undefined;
  const click = primary.invoke();
  await assertRejects(() => hub.run("probe.primary"), Error, "unavailable");
  await primary.invoke(); // Enter cannot admit a second effect either.
  assertEquals(effects, 1);
  gate.resolve();
  await click;
  reason = "Reconnect to send";
  await assertRejects(() => hub.run("probe.primary"), Error, "unavailable");
  assertEquals(effects, 1);
});
