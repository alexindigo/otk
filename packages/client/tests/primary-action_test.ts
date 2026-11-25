// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { CommandHub, createPrimaryAction } from "@otk/client";

Deno.test("primary actions capture their mode at invocation", async () => {
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
