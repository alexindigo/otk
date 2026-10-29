// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type Part,
  type TurnUsageDetail,
  UsageLedger,
  type UsageMessage,
} from "@otk/protocol";
import {
  createSessionUsage,
  type SessionUsageOwner,
} from "../session-usage.ts";
import { createState } from "../state.ts";
import { shellEntry } from "./shell-fixture.ts";
import type { SidecarConnection } from "../connection.ts";
const snapshot = (ledger: UsageLedger): TurnUsageDetail => ({
  ...ledger.detail("user"),
  version: { generation: 0, revision: 0 },
  clock: { epoch: "test", seq: 0 },
});
const policy = {
  coolms: 300000,
  recoveryconcurrency: 2,
  recoverypending: 128,
  preloadms: 30000,
  concurrency: 4,
  replayops: 128,
  replaybytes: 4194304,
  retryms: 1000,
};
const header = (input: number, completed = false): UsageMessage => ({
  id: "step",
  turnID: "user",
  model: { provider: "one", model: "model" },
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: input * .1,
  completed,
});
Deno.test("usage resource merges buffered tool labels, header-only updates and removals through the same ledger", async () => {
  const gate = Promise.withResolvers<TurnUsageDetail>();
  const owner = createSessionUsage(() =>
    ({
      supports: () => true,
      messages: policy,
      rpc: { call: () => gate.promise },
    }) as unknown as SidecarConnection
  );
  const pending = owner.load(target);
  await Promise.resolve();
  const part: Part = {
    kind: "tool",
    id: "tool",
    call: {
      tool: "search",
      sourceName: "glob",
      callID: "c",
      title: "Find files",
      status: "completed",
      awaitingPermission: false,
      time: {},
      mode: "glob",
      pattern: "**/*",
      matches: 3,
    },
  };
  owner.receive("local", {
    t: "content",
    sessionID: "s",
    event: { op: "part.upsert", messageID: "step", part },
  });
  gate.resolve(snapshot(new UsageLedger("s", [header(3)])));
  await pending;
  assertEquals(owner.get(target)?.calls[0].tools, [{
    id: "tool",
    name: "glob",
    summary: "Find files",
  }]);
  owner.receive("local", {
    t: "content",
    sessionID: "s",
    event: {
      op: "message.upsert",
      message: {
        id: "step",
        sessionID: "s",
        role: "assistant",
        replyTo: "user",
        agent: "build",
        model: header(4).model,
        tokens: header(4).tokens,
        cost: .4,
        interrupted: false,
        time: { created: 1, completed: 10 },
        parts: [],
      },
    },
  });
  assertEquals(owner.get(target)?.calls[0].tools?.length, 1);
  assertEquals(owner.get(target)?.summary.time, { start: 1, end: 10 });
  owner.receive("local", {
    t: "content",
    sessionID: "s",
    event: { op: "part.remove", messageID: "step", partID: "tool" },
  });
  assertEquals(owner.get(target)?.calls[0].tools, []);
  owner.stop();
});
const target = { sidecarId: "local", sessionID: "s", turnID: "user" };
Deno.test("open detail refreshes only for a newer digest revision, never a status upsert or stale digest", async () => {
  const entry = shellEntry("s");
  entry.digest.revision = 7;
  let reads = 0;
  const connection = () =>
    ({
      supports: () => true,
      rpc: {
        call: () => {
          reads++;
          return Promise.resolve(
            snapshot(new UsageLedger("s", [header(2, true)])),
          );
        },
      },
    }) as unknown as SidecarConnection;
  const owner: SessionUsageOwner = Reflect.apply(
    createSessionUsage,
    undefined,
    [connection, createState, () => entry],
  );
  const release = owner.retain(target);
  try {
    await owner.load(target);
    owner.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{ op: "upsert", entry: { ...entry, status: "busy" } }],
    });
    await owner.load(target);
    assertEquals(reads, 1);
    const patch = (revision: number, wire: number) =>
      owner.receive("local", {
        t: "index.patch",
        rev: wire,
        ops: [{
          op: "digest",
          id: "s",
          revision,
          summary: { state: "ready", revision },
          turns: { upsert: {}, remove: [] },
          deleted: null,
        }],
      });
    entry.digest.revision = 8;
    entry.digest.turns.user = new UsageLedger("s", [header(3, true)]).summary(
      "user",
    )!;
    patch(8, 2);
    await owner.load(target);
    assertEquals(reads, 2);
    patch(8, 3);
    patch(7, 4);
    await owner.load(target);
    assertEquals(reads, 2);
  } finally {
    release();
    owner.stop();
  }
});
Deno.test("index-bound turn detail accepts honest reported zero and keyed removal without page-based estimates", async () => {
  const entry = shellEntry("s");
  entry.digest.revision = 7;
  const connection = () =>
    ({
      supports: () => true,
      rpc: {
        call: () =>
          Promise.resolve(snapshot(new UsageLedger("s", [header(2, true)]))),
      },
    }) as unknown as SidecarConnection;
  const owner: SessionUsageOwner = Reflect.apply(
    createSessionUsage,
    undefined,
    [connection, createState, () => entry],
  );
  const release = owner.retain(target);
  try {
    await owner.load(target);
    owner.receive("local", {
      t: "content",
      sessionID: "s",
      event: {
        op: "message.upsert",
        message: {
          id: "step",
          sessionID: "s",
          role: "assistant",
          replyTo: "user",
          agent: "build",
          model: header(0).model,
          time: { created: 1, completed: 2 },
          tokens: header(0).tokens,
          cost: 0,
          interrupted: false,
          parts: [],
        },
      },
    });
    assertEquals(owner.get(target)?.summary.cost, 0);
    owner.receive("local", {
      t: "content",
      sessionID: "s",
      event: { op: "message.remove", messageID: "step" },
    });
    assertEquals(owner.get(target)?.summary.cost, 0);
  } finally {
    release();
    owner.stop();
  }
});
Deno.test("a known tombstone cannot acquire or load usage even before the old view unmounts", async () => {
  const entry = shellEntry("s");
  entry.deleted = { at: 1, how: "provider" };
  let reads = 0;
  const connection = () =>
    ({
      supports: () => true,
      rpc: {
        call: () => {
          reads++;
          return Promise.resolve(snapshot(new UsageLedger("s")));
        },
      },
    }) as unknown as SidecarConnection;
  const owner: SessionUsageOwner = Reflect.apply(
    createSessionUsage,
    undefined,
    [connection, createState, () => entry],
  );
  const release = owner.retain(target);
  try {
    await owner.load(target);
    assertEquals(reads, 0);
    assertEquals(owner.get(target), undefined);
  } finally {
    release();
    owner.stop();
  }
});
Deno.test("full usage resource coalesces reads and replaces buffered/duplicate live headers without counting snapshots twice", async () => {
  const gate = Promise.withResolvers<TurnUsageDetail>();
  let calls = 0;
  const owner = createSessionUsage(() =>
    ({
      supports: () => true,
      messages: policy,
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
    if (Object.values(owner.state.entries).some((entry) => entry.loading)) {
      joined = owner.load(target);
    }
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
  gate.resolve(snapshot(new UsageLedger("s", [header(3)])));
  await pending;
  await joined;
  assertEquals(calls, 1);
  assertEquals(owner.get(target)?.summary.tokens.input, 3);
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
  assertEquals(owner.get(target)?.summary.tokens.input, 4);
  assertEquals(owner.get(target)?.summary.cost, .4);
  owner.receive("local", {
    t: "content",
    sessionID: "s",
    event: { op: "message.remove", messageID: "step" },
  });
  assertEquals(owner.get(target)?.summary.tokens.input, 0);
  release();
  owner.stop();
  assertEquals(owner.state.entries, {});
});
Deno.test("usage reconnect rejects old generations, isolates targets and exposes whole-session totals for other consumers", async () => {
  const first = Promise.withResolvers<TurnUsageDetail>(),
    second = Promise.withResolvers<TurnUsageDetail>();
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
              snapshot(new UsageLedger("another", [header(2, true)])),
            ),
      },
    }) as unknown as SidecarConnection
  );
  const old = owner.load(target);
  await Promise.resolve();
  owner.receive("local", {
    t: "transcript.invalidated",
    version: { generation: 1, revision: 0 },
  });
  const current = owner.load(target);
  await Promise.resolve();
  first.resolve(snapshot(new UsageLedger("s", [header(1)])));
  await old;
  second.resolve({
    ...snapshot(new UsageLedger("s", [header(7, true)])),
    version: { generation: 1, revision: 0 },
  });
  await current;
  await owner.load(target);
  assertEquals(owner.get(target)?.summary.tokens.input, 7);
  assertEquals(
    owner.get({ sidecarId: "elsewhere", sessionID: "s", turnID: "user" }),
    undefined,
  );
  await owner.load({
    sidecarId: "local",
    sessionID: "another",
    turnID: "user",
  });
  assertEquals(
    owner.get({ sidecarId: "local", sessionID: "another", turnID: "user" })
      ?.summary.tokens.input,
    2,
  );
  assertEquals(owner.get(target)?.summary.tokens.input, 7);
  owner.stop();
});
