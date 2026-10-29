// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { AssistantMessage, HelperSummary } from "@otk/protocol";
import { createTranscriptProjection } from "../transcript-projection.ts";
import { createIndex, createTranscripts, SidecarConnection } from "@otk/client";
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../../tests/support/message-pages.ts";
import { shellEntry } from "./shell-fixture.ts";
import type { ClientFrame } from "@otk/protocol";

const task = (id: string) => ({
  id,
  kind: "tool" as const,
  call: {
    tool: "task" as const,
    callID: id,
    awaitingPermission: false,
    title: "Inspect",
    status: "completed" as const,
    description: "Inspect",
    childSessionID: "tstv1-child",
    time: { start: 1, end: 2 },
  },
});
const linked = (): AssistantMessage => ({
  id: "a",
  sessionID: "tstv1-parent",
  role: "assistant",
  replyTo: "u",
  model: { provider: "test", model: "test" },
  agent: "build",
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
  interrupted: false,
  time: { created: 1, completed: 2 },
  parts: [task("one"), task("two")],
});

Deno.test("helper metadata dependency counts survive partial removal and retire on clear or deletion", () => {
  const projection = createTranscriptProjection(),
    ids = new Set(["tstv1-child"]);
  projection.replace([linked()]);
  assertEquals(projection.usesMetadata(ids), true);
  projection.apply({ op: "part.remove", messageID: "a", partID: "one" });
  assertEquals(projection.usesMetadata(ids), true);
  projection.apply({ op: "part.remove", messageID: "a", partID: "two" });
  assertEquals(projection.usesMetadata(ids), false);
  projection.replace([linked()]);
  projection.apply({ op: "message.remove", messageID: "a" });
  assertEquals(projection.usesMetadata(ids), false);
  projection.replace([linked()]);
  projection.clear();
  assertEquals(projection.usesMetadata(ids), false);
});

Deno.test("changed child metadata reaches the parent consumer without a child body read", async () => {
  const index = createIndex();
  index.receive("server", {
    t: "index.snapshot",
    rev: 0,
    entries: [shellEntry("tstv1-parent"), shellEntry("tstv1-child")],
  });
  const requests: Extract<ClientFrame, { t: "rpc" }>[] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  connection.subscribe = () => {};
  connection.send = (frame) => {
    if (frame.t === "rpc") requests.push(frame);
  };
  const owner = createTranscripts({
    connection: () => connection,
    entry: (server, id) => index.get(server, id),
    changes: (server) => index.changes(server),
  });
  const target = { sidecarId: "server", sessionID: "tstv1-parent" };
  try {
    owner.setDemand({
      scope: { sidecarId: "server", directory: "/p" },
      sessions: [target],
      selected: target,
    });
    const request = requests.find((frame) =>
      frame.method === "session.messages"
    )!;
    connection.rpc.receive({
      t: "rpc.result",
      id: request.id,
      ok: true,
      result: fixturePage(target.sessionID, [linked()]),
    });
    for (let i = 0; i < 15; i++) await Promise.resolve();
    const frame = {
      t: "index.patch" as const,
      rev: 1,
      ops: [{
        op: "digest" as const,
        id: "tstv1-child",
        revision: 1,
        summary: { state: "ready" as const, revision: 1 },
        turns: { upsert: {}, remove: [] },
        deleted: null,
        helper: { state: "ready" as const, revision: 1, toolCount: 2 },
      }],
    };
    index.receive("server", frame);
    owner.receive("server", frame, true);
    const part = owner.get(target)!.state.messagesByID.a.parts[0];
    assertEquals(
      part.kind === "tool" && part.call.tool === "task" &&
        part.call.progress?.toolCount,
      2,
    );
    assertEquals(
      requests.filter((request) => request.method === "session.messages")
        .length,
      1,
    );
  } finally {
    owner.stop();
    connection.rpc.close();
  }
});
Deno.test("borrowed helper digests patch keyed parts, deduplicate content delivery and retire replaced links", () => {
  const projection = createTranscriptProjection();
  const message: AssistantMessage = {
    id: "a",
    sessionID: "tstv1-parent",
    role: "assistant",
    replyTo: "u",
    model: { provider: "test", model: "test" },
    agent: "build",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    time: { created: 1, completed: 5 },
    parts: [{
      id: "task",
      kind: "tool",
      call: {
        tool: "task",
        callID: "call",
        awaitingPermission: false,
        title: "Inspect",
        status: "completed",
        description: "Inspect",
        childSessionID: "tstv1-child",
        time: { start: 1, end: 5 },
      },
    }],
  };
  projection.replace([message]);
  const summary: HelperSummary = {
    state: "ready",
    revision: 1,
    toolCount: 2,
    time: { start: 2, end: 20 },
  };
  assertEquals(projection.helpers(() => summary), true);
  const current = projection.state.messagesByID.a;
  const part = current.parts[0];
  assertEquals(
    part.kind === "tool" && part.call.tool === "task" &&
      part.call.progress?.toolCount,
    2,
  );
  assertEquals(
    part.kind === "tool" && part.call.time.end,
    5,
    "Derived helper time cannot rewrite parent completion",
  );
  projection.apply({
    op: "task.progress",
    messageID: "a",
    partID: "task",
    childSessionID: "tstv1-child",
    summary,
  });
  assertStrictEquals(projection.state.messagesByID.a, current);
  projection.apply({ op: "part.remove", messageID: "a", partID: "task" });
  let reads = 0;
  projection.helpers(() => {
    reads++;
    return summary;
  });
  assertEquals(reads, 0);
  projection.clear();
  assertEquals(projection.state.messageIDs, []);
});
