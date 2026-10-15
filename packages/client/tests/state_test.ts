// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { Message, Part } from "@otk/protocol";
import type { IndexEntry } from "@otk/protocol";
import type { ClientFrame } from "@otk/protocol";
import { acceptsPatch, createIndex, projectGroups } from "@otk/client";
import {
  emptyContent,
  hashFor,
  readSidecars,
  reduce,
  route,
  Rpc,
} from "@otk/client";
const entry = (id: string, parentID?: string): IndexEntry => ({
  id,
  parentID,
  directory: "/projects/otk",
  projectID: "project",
  title: id,
  timeCreated: 1,
  timeUpdated: 2,
  archived: false,
  status: "idle",
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
});
const message: Message = {
  id: "message",
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  parts: [],
};
const part: Part = {
  id: "part",
  kind: "text",
  synthetic: false,
  blocks: [{ b: "paragraph", inline: [{ i: "text", text: "tail" }] }],
};
Deno.test("web reducer replays independent headers/parts and replaces streaming tails without mutating history", () => {
  const empty = emptyContent();
  let state = reduce(empty, { op: "message.upsert", message });
  state = reduce(state, { op: "part.upsert", messageID: message.id, part });
  const before = state;
  state = reduce(state, {
    op: "message.upsert",
    message: { ...message, time: { created: 2 } },
  });
  assertEquals(state.messages[0].parts, [part]);
  state = reduce(state, {
    op: "part.blocks",
    messageID: message.id,
    partID: part.id,
    from: 0,
    blocks: [{
      b: "heading",
      level: 1,
      inline: [{ i: "text", text: "final" }],
    }],
  });
  assertEquals(before.messages[0].parts, [part]);
  assertEquals(
    (state.messages[0].parts[0] as Part & { kind: "text" }).blocks[0].b,
    "heading",
  );
  state = reduce(state, {
    op: "part.remove",
    messageID: message.id,
    partID: part.id,
  });
  assertEquals(state.messages[0].parts, []);
  state = reduce(state, {
    op: "todo.set",
    items: [{ content: "task", status: "pending", priority: "high" }],
  });
  state = reduce(state, {
    op: "diff.set",
    files: [{
      path: "a",
      status: "added",
      additions: 1,
      deletions: 0,
      hunks: [],
    }],
  });
  assertEquals(state.todos.length, 1);
  assertEquals(state.diffs.length, 1);
  state = reduce(state, { op: "message.remove", messageID: message.id });
  assertEquals(state.messages, []);
  assertEquals(empty.messages, []);
});
Deno.test("web merged index isolates sidecar snapshots, refuses revision gaps and hides descendants", () => {
  const index = createIndex();
  index.receive("one", {
    t: "index.snapshot",
    rev: 3,
    entries: [entry("root"), entry("child", "root")],
  });
  index.receive("two", {
    t: "index.snapshot",
    rev: 9,
    entries: [entry("root")],
  });
  assertEquals(Object.keys(index.state.entries).sort(), [
    "one/child",
    "one/root",
    "two/root",
  ]);
  assertEquals(
    projectGroups(Object.values(index.state.entries), "one")[0].entries.map((
      e,
    ) => e.id),
    ["root"],
  );
  assert(
    !index.receive("one", {
      t: "index.patch",
      rev: 10,
      ops: [{ op: "remove", id: "root" }],
    }),
  );
  assert(index.state.entries["one/root"]);
  assert(
    index.receive("one", {
      t: "index.patch",
      rev: 4,
      ops: [{ op: "remove", id: "child" }],
    }),
  );
  index.receive("one", { t: "index.snapshot", rev: 20, entries: [] });
  assertEquals(Object.keys(index.state.entries), ["two/root"]);
  assert(!acceptsPatch(undefined, { t: "index.patch", rev: 1, ops: [] }));
  index.remove("two");
  assertEquals(Object.keys(index.state.entries), []);
});
Deno.test("web sidecar persistence keeps the implicit source and rejects duplicate identities/URLs", () => {
  const read = (value: unknown) =>
    readSidecars({ getItem: () => JSON.stringify(value) });
  assertEquals(read([]), [{ id: "local", baseUrl: "", label: "This sidecar" }]);
  assertEquals(
    read([{ id: "local", baseUrl: "http://other", label: "replace" }, {
      id: "r",
      baseUrl: "http://remote/",
      label: "remote",
    }, { id: "r2", baseUrl: "http://remote", label: "duplicate" }]).map((s) =>
      s.id
    ),
    ["local", "r"],
  );
  assertEquals(readSidecars({ getItem: () => "broken" }).length, 1);
});
Deno.test("web URL round-trips selection and rejects malformed hashes", () => {
  const selection = { sidecarId: "remote id", sessionID: "session/with space" };
  assertEquals(route(hashFor(selection)), selection);
  const child = { sidecarId: "local", sessionID: "child", rootID: "root" };
  assertEquals(route(hashFor(child)), child);
  assertEquals(route("#/local/root/child/extra"), undefined);
  assertEquals(route("#/missing"), undefined);
  assertEquals(route("#/%zz/x"), undefined);
});
Deno.test("web RPC owns pending calls until result, cancellation or disconnect", async () => {
  const frames: ClientFrame[] = [],
    rpc = new Rpc((frame) => frames.push(frame));
  const promise = rpc.call("session.children", { sessionID: "x" });
  assert(frames[0].t === "rpc");
  rpc.receive({ t: "rpc.result", id: frames[0].id, ok: true, result: [] });
  assertEquals(await promise, []);
  const abort = new AbortController();
  const cancelled = rpc.call("session.get", { sessionID: "x" }, abort.signal)
    .catch((e) => e.message);
  abort.abort();
  assertEquals(await cancelled, "Request cancelled");
  const disconnected = rpc.call("session.get", { sessionID: "x" }).catch((e) =>
    e.message
  );
  rpc.close();
  assertEquals(await disconnected, "Sidecar disconnected");
});
