// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { ClientFrame, ContentSession, Message } from "@otk/protocol";
import {
  createCurrentClient,
  createNavigation,
  createSession,
  createState,
  loadHistory,
  type Selection,
  SidecarConnection,
} from "@otk/client";

function fixture() {
  const frames: Extract<ClientFrame, { t: "rpc" }>[] = [];
  const subscriptions: [string, boolean][] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  });
  connection.send = (frame) => {
    if (frame.t === "rpc") frames.push(frame);
  };
  connection.supports = () => false;
  connection.subscribe = (id, enabled) => {
    subscriptions.push([id, enabled]);
  };
  const answer = (method: string, result: unknown) => {
    const at = frames.findIndex((frame) => frame.method === method);
    assert(at >= 0, method);
    const frame = frames.splice(at, 1)[0];
    connection.rpc.receive({ t: "rpc.result", id: frame.id, ok: true, result });
  };
  const session = createSession(() => connection, () => undefined);
  return { connection, session, answer, frames, subscriptions };
}
const info = (id: string): ContentSession => ({
  id,
  title: id,
  directory: "/project",
  projectID: "p",
  archived: false,
  time: { created: 1, updated: 2 },
});
const message = (id: string): Message => ({
  id,
  sessionID: "s",
  role: "user",
  time: { created: 1 },
  parts: [],
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

Deno.test("plain session replays buffered ops, refetches resync and releases selection without optional RPCs", async () => {
  const { connection, session, answer, subscriptions } = fixture();
  let changes = 0;
  const unsubscribe = session.subscribe(() => changes++);
  try {
    session.open({ sidecarId: "core", sessionID: "s" });
    session.receive("other", {
      t: "content",
      sessionID: "s",
      event: { op: "message.upsert", message: message("ignored") },
    });
    session.receive("core", {
      t: "content",
      sessionID: "s",
      event: { op: "message.upsert", message: message("live") },
    });
    answer("session.get", info("s"));
    answer("session.messages", [message("snapshot")]);
    await settle();
    assertEquals(session.state.content.messages.map((m) => m.id), [
      "live",
      "snapshot",
    ]);
    assertEquals(session.state.loading, false);
    assertEquals(session.state.exhausted, true);
    session.receive("core", { t: "resync", sessionIDs: "all" });
    answer("session.get", info("s"));
    answer("session.messages", []);
    await settle();
    assertEquals(session.state.content.messages, []);
    assert(changes >= 4);
    unsubscribe();
    const before = changes;
    session.stop();
    assertEquals(changes, before);
    assertEquals(subscriptions, [["s", true], ["s", false]]);
  } finally {
    session.stop();
    connection.stop();
  }
});

Deno.test("plain session generations cancel superseded loads and paging deduplicates older messages", async () => {
  const { connection, session, answer, subscriptions } = fixture();
  try {
    session.open({ sidecarId: "core", sessionID: "old" });
    session.open({ sidecarId: "core", sessionID: "s" });
    answer("session.get", info("old"));
    answer("session.messages", [message("obsolete")]);
    const page = Array.from({ length: 100 }, (_, n) => message(String(n)));
    answer("session.get", info("s"));
    answer("session.messages", page);
    await settle();
    assertEquals(session.state.info?.id, "s");
    assertEquals(session.state.exhausted, false);
    const older = session.older();
    assertEquals(session.state.paging, true);
    answer("session.messages", [message("older"), message("0")]);
    await older;
    assertEquals(session.state.content.messages.length, 101);
    assertEquals(session.state.content.messages[0].id, "older");
    assertEquals(session.state.exhausted, true);
    assertEquals(session.state.paging, false);
    assertEquals(subscriptions, [["old", true], ["old", false], ["s", true]]);
  } finally {
    session.stop();
    connection.stop();
  }
});

Deno.test("current RPC context follows selection and history retains partial results and attachment owners", async () => {
  const one = fixture(), two = fixture();
  let selection: Selection | undefined;
  const current = createCurrentClient(
    () => selection,
    (id) => id === "one" ? one.connection : two.connection,
  );
  try {
    assertThrows(() => current.context(), Error, "No session selected");
    selection = { sidecarId: "one", sessionID: "s1" };
    const first = current.call("session.get", {});
    assertEquals(one.frames[0].params, { sessionID: "s1" });
    one.answer("session.get", info("s1"));
    await first;
    selection = { sidecarId: "two", sessionID: "s2" };
    const second = current.call("session.get", {});
    assertEquals(two.frames[0].params, { sessionID: "s2" });
    two.answer("session.get", info("s2"));
    await second;
    const history = loadHistory([{ id: "one", connection: one.connection }, {
      id: "two",
      connection: two.connection,
    }]);
    one.answer("history.list", [{
      input: "file",
      mode: "normal",
      time: 2,
      parts: [{
        kind: "file",
        source: "history",
        name: "a",
        mime: "text/plain",
        size: 1,
        messageID: "m",
        partID: "p",
      }],
    }]);
    two.connection.rpc.close();
    assertEquals((await history)[0].parts[0], {
      kind: "file",
      source: "history",
      name: "a",
      mime: "text/plain",
      size: 1,
      messageID: "m",
      partID: "p",
      sidecarID: "one",
    });
  } finally {
    one.connection.stop();
    two.connection.stop();
  }
});

Deno.test("plain navigation restores cancelled traversal and then applies a queued intent", () => {
  const location = { hash: "#one", pathname: "/", search: "" };
  let state: unknown = null, listener: (() => void) | undefined;
  const entries: { hash: string; state: unknown }[] = [{ hash: "#one", state }];
  let at = 0, pending: number | undefined, accept = true;
  const applied: string[] = [];
  const history = {
    get state() {
      return state;
    },
    replaceState(value: unknown) {
      state = value;
      entries[at].state = value;
    },
    pushState(value: unknown, _unused: string, url?: string | URL | null) {
      state = value;
      location.hash = String(url).slice(1);
      entries.splice(++at, entries.length, { hash: location.hash, state });
    },
    go(delta: number) {
      pending = delta;
    },
  };
  const navigation = createNavigation({
    accept: () => accept,
    apply: (hash) => applied.push(hash),
    intent() {},
  }, {
    history,
    location,
    listen(changed) {
      listener = changed;
      return () => {
        listener = undefined;
      };
    },
  });
  const traverse = (delta: number) => {
    at += delta;
    ({ hash: location.hash, state } = entries[at]);
    listener?.();
  };
  navigation.start();
  navigation.open("#two");
  accept = false;
  traverse(-1);
  assertEquals(pending, 1);
  assertEquals(applied, ["#one", "#two"]);
  assertEquals(navigation.open("#three"), false);
  accept = true;
  traverse(pending!);
  assertEquals(applied, ["#one", "#two", "#three"]);
  navigation.stop();
  assertEquals(listener, undefined);
  assertEquals(navigation.open("#four"), false);
});

Deno.test("plain state reconciliation preserves the target and notifies only subscribed owners", () => {
  const store = createState({ entries: { old: 1 } as Record<string, number> });
  const target = store.state.entries;
  let calls = 0;
  const stop = store.subscribe(() => calls++);
  store.update((state) => store.reconcile(state.entries, { current: 2 }));
  assertEquals(store.state.entries, { current: 2 });
  assert(store.state.entries === target);
  assertEquals(calls, 1);
  stop();
  store.update((state) => {
    state.entries.next = 3;
  });
  assertEquals(calls, 1);
});
