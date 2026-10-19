// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type SessionUsage,
  UsageLedger,
  type UsageMessage,
} from "@otk/protocol";
import { createSessionUsage } from "../session-usage.ts";
import type { SidecarConnection } from "../connection.ts";
const header = (input: number, completed = false): UsageMessage => ({
  id: "step",
  turnID: "user",
  model: { provider: "one", model: "model" },
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: input * .1,
  completed,
});
const target = { sidecarId: "local", sessionID: "s" };
Deno.test("full usage resource coalesces reads and replaces buffered/duplicate live headers without counting snapshots twice", async () => {
  const gate = Promise.withResolvers<SessionUsage>();
  let calls = 0;
  const owner = createSessionUsage(() =>
    ({
      supports: () => true,
      rpc: {
        call: () => {
          calls++;
          return gate.promise;
        },
      },
    }) as unknown as SidecarConnection
  );
  let joined: Promise<void> | undefined;
  const release = owner.subscribe(() => {
    if (owner.state.entries["local/s"]?.loading) joined = owner.load(target);
  });
  const pending = owner.load(target);
  await Promise.resolve();
  const message = {
    id: "step",
    sessionID: "s",
    role: "assistant" as const,
    replyTo: "user",
    agent: "build",
    model: header(3).model,
    tokens: header(3).tokens,
    cost: .3,
    time: { created: 1 },
    parts: [],
    interrupted: false,
  };
  owner.receive("local", {
    t: "content",
    sessionID: "s",
    event: { op: "message.upsert", message },
  });
  gate.resolve(new UsageLedger("s", [header(3)]).snapshot());
  await pending;
  await joined;
  assertEquals(calls, 1);
  assertEquals(owner.get(target)?.total.tokens.input, 3);
  for (let i = 0; i < 2; i++) {
    owner.receive("local", {
      t: "content",
      sessionID: "s",
      event: {
        op: "message.upsert",
        message: {
          ...message,
          tokens: header(4).tokens,
          cost: .4,
          time: { created: 1, completed: 2 },
        },
      },
    });
  }
  owner.receive("local", {
    t: "content",
    sessionID: "s",
    event: { op: "message.upsert", message },
  });
  assertEquals(owner.get(target)?.turns.user.tokens.input, 4);
  assertEquals(owner.get(target)?.total.cost, .4);
  owner.receive("local", {
    t: "content",
    sessionID: "s",
    event: { op: "message.remove", messageID: "step" },
  });
  assertEquals(owner.get(target)?.total.tokens.input, 0);
  release();
  owner.stop();
  assertEquals(owner.state.entries, {});
});
Deno.test("usage reconnect rejects old generations, isolates targets and exposes whole-session totals for other consumers", async () => {
  const first = Promise.withResolvers<SessionUsage>(),
    second = Promise.withResolvers<SessionUsage>();
  let calls = 0;
  const owner = createSessionUsage(() =>
    ({
      supports: () => true,
      rpc: {
        call: () =>
          ++calls === 1
            ? first.promise
            : calls === 2
            ? second.promise
            : Promise.resolve(
              new UsageLedger("another", [header(2, true)]).snapshot(),
            ),
      },
    }) as unknown as SidecarConnection
  );
  const old = owner.load(target);
  await Promise.resolve();
  owner.receive("local", { t: "resync", sessionIDs: "all" });
  const current = owner.load(target);
  await Promise.resolve();
  first.resolve(new UsageLedger("s", [header(1)]).snapshot());
  await old;
  second.resolve(new UsageLedger("s", [header(7, true)]).snapshot());
  await current;
  assertEquals(owner.get(target)?.total.tokens.input, 7);
  assertEquals(
    owner.get({ sidecarId: "elsewhere", sessionID: "s" }),
    undefined,
  );
  await owner.load({ sidecarId: "local", sessionID: "another" });
  assertEquals(
    owner.get({ sidecarId: "local", sessionID: "another" })?.total.tokens.input,
    2,
  );
  assertEquals(owner.get(target)?.total.tokens.input, 7);
  owner.stop();
});
