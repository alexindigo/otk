// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import {
  type ClientIndex,
  type ClientSidecars,
  createIndex,
  createServerResources,
  createState,
  SidecarConnection,
  type SidecarState,
} from "@otk/client";
import type { InboxSnapshot, IndexEntry, ServerFrame } from "@otk/protocol";

function entry(id = "session", directory = "/p"): IndexEntry {
  return {
    id,
    directory,
    projectID: "p",
    title: id,
    status: "busy",
    archived: false,
    timeCreated: 1,
    timeUpdated: 2,
    attention: {
      permissions: 1,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}
function metadata(): InboxSnapshot {
  return {
    projects: [{
      directory: "/p",
      order: 0,
      lastVisit: 1,
      inactive: false,
      added: true,
    }],
    tasks: [{
      id: "task",
      directory: "/p",
      name: "Task",
      sessions: ["session"],
      order: 0,
    }],
    seen: { session: 1 },
    finishes: { session: 2 },
    pathTemplates: [],
  };
}
function fixture() {
  const calls: unknown[] = [], order: string[] = [];
  const store = createState<{ list: SidecarState[] }>({
    list: ["local", "remote"].map((id) => ({
      id,
      baseUrl: "",
      label: id === "local" ? "This server" : "Other machine",
      status: "connected",
      harness: "connected",
      capabilities: ["history", "models"],
      connectionVersion: 1,
    })),
  });
  const connections = new Map(["local", "remote"].map((id) => {
    const connection = new SidecarConnection("http://127.0.0.1:1502", {
      status() {},
      frame() {},
    });
    connection.rpc.call = (method, params) => {
      calls.push([id, method, params]);
      if (method === "session.get") {
        return Promise.resolve(entry("missing")) as never;
      }
      if (method === "tasks.create") {
        return Promise.resolve({
          id: "new-task",
          directory: "/p",
          name: "missing",
          sessions: ["missing"],
          order: 0,
        }) as never;
      }
      return Promise.resolve(undefined) as never;
    };
    connection.send = (frame) => {
      calls.push([id, frame]);
    };
    return [id, connection] as const;
  }));
  const baseIndex = createIndex();
  const index: ClientIndex = {
    ...baseIndex,
    receive(id, frame) {
      order.push(`index:${id}`);
      return baseIndex.receive(id, frame);
    },
    remove(id) {
      order.push(`index.remove:${id}`);
      baseIndex.remove(id);
    },
  };
  let receive!: (id: string, frame: ServerFrame) => void;
  const sidecars: ClientSidecars = {
    state: store.state,
    subscribe: store.subscribe,
    connection: (id) => connections.get(id)!,
    start() {},
    stop() {
      order.push("sidecars.stop");
    },
    add(url, label) {
      calls.push(["add", url, label]);
      return Promise.resolve("added");
    },
    remove(id) {
      order.push(`sidecars.remove:${id}`);
    },
  };
  const resources = createServerResources({
    index,
    sidecars: (listener) => {
      receive = listener;
      return sidecars;
    },
  });
  return { resources, index, calls, order, receive, store, sidecars };
}

Deno.test("server resources stage frames and expose acceptance after approvals, index and inbox", () => {
  const f = fixture(), seen: unknown[] = [];
  f.resources.approvals("local").subscribe(() => f.order.push("approvals"));
  f.resources.inbox("local").subscribe(() => f.order.push("inbox"));
  f.resources.observe({
    frame(id, frame, accepted) {
      f.order.push("observer1");
      seen.push([id, frame.t, accepted, f.resources.entry(id, "session")?.id]);
    },
  });
  const release = f.resources.observe({
    frame() {
      f.order.push("observer2");
    },
  });
  f.receive("local", {
    t: "approvals",
    approvals: { enabled: ["session"], revision: 0 },
  });
  assertEquals(f.order, ["approvals", "observer1", "observer2"]);
  f.order.length = 0;
  f.receive("local", { t: "index.snapshot", rev: 0, entries: [entry()] });
  assertEquals(f.order, ["index:local", "observer1", "observer2"]);
  assertEquals(seen.at(-1), ["local", "index.snapshot", true, "session"]);
  f.receive("local", {
    t: "index.patch",
    rev: 4,
    ops: [{ op: "remove", id: "session" }],
  });
  assertEquals(seen.at(-1), ["local", "index.patch", false, "session"]);
  assertEquals(f.calls, [["local", { t: "resnapshot" }]]);
  f.order.length = 0;
  release();
  release();
  f.receive("local", { t: "inbox", inbox: metadata() });
  assertEquals(f.order, ["inbox", "observer1"]);
  assertEquals(f.resources.inbox("local").state.inbox, metadata());
  f.resources.stop();
});

Deno.test("server resources cache per server and per server-directory with readiness ports", async () => {
  const f = fixture(), p = { sidecarId: "local", directory: "/p" };
  assertStrictEquals(f.resources.sidecars, f.sidecars);
  assertStrictEquals(f.resources.inbox("local"), f.resources.inbox("local"));
  assertNotStrictEquals(
    f.resources.inbox("local"),
    f.resources.inbox("remote"),
  );
  assertStrictEquals(
    f.resources.approvals("local"),
    f.resources.approvals("local"),
  );
  assertNotStrictEquals(
    f.resources.approvals("local"),
    f.resources.approvals("remote"),
  );
  assertStrictEquals(f.resources.tabs(p), f.resources.tabs({ ...p }));
  assertNotStrictEquals(
    f.resources.tabs(p),
    f.resources.tabs({ ...p, directory: "/other" }),
  );
  assertNotStrictEquals(
    f.resources.tabs(p),
    f.resources.tabs({ ...p, sidecarId: "remote" }),
  );
  assertNotStrictEquals(f.resources.taskActions(p), f.resources.taskActions(p));
  // No index row or view-sync effect: pin must still resolve authoritative metadata.
  await f.resources.tabs(p).pin("missing");
  assertEquals(f.calls.slice(0, 2), [
    ["local", "session.get", { sessionID: "missing" }],
    ["local", "tasks.create", {
      directory: "/p",
      name: "missing",
      sessions: ["missing"],
    }],
  ]);
  f.resources.stop();
});

Deno.test("server resource removal preserves observer order and evicts every server-owned cache", () => {
  const f = fixture(),
    inbox = f.resources.inbox("remote"),
    approvals = f.resources.approvals("remote");
  const p = { sidecarId: "remote", directory: "/p" },
    tabs = f.resources.tabs(p);
  f.receive("remote", { t: "index.snapshot", rev: 0, entries: [entry()] });
  f.resources.observe({
    removed(id) {
      assertEquals(f.resources.entry(id, "session"), undefined);
      assertStrictEquals(f.resources.inbox(id), inbox);
      f.order.push(`removed:${id}`);
    },
  });
  f.order.length = 0;
  f.resources.remove("remote");
  assertEquals(f.order, [
    "index.remove:remote",
    "removed:remote",
    "sidecars.remove:remote",
  ]);
  assertNotStrictEquals(f.resources.inbox("remote"), inbox);
  assertNotStrictEquals(f.resources.approvals("remote"), approvals);
  assertNotStrictEquals(f.resources.tabs(p), tabs);
  f.resources.stop();
});

Deno.test("server resources project per-server attention and labelled projects from live liveness", () => {
  const f = fixture();
  for (const id of ["local", "remote"]) {
    f.receive(id, { t: "index.snapshot", rev: 0, entries: [entry()] });
    f.receive(id, { t: "inbox", inbox: metadata() });
  }
  f.receive("local", {
    t: "approvals",
    approvals: { enabled: ["session"], revision: 0 },
  });
  assertEquals(
    f.resources.entries().map((e) => [e.sidecarId, e.attention.permissions]),
    [["local", 0], ["remote", 1]],
  );
  assertEquals(
    f.resources.projectEntries({ sidecarId: "local", directory: "/other" }),
    [],
  );
  assertEquals(
    f.resources.projects(100).map((p) => [p.sidecarId, p.label, p.status]),
    [["local", "This server", "working"], [
      "remote",
      "Other machine",
      "blocked",
    ]],
  );
  f.store.update((s) => {
    s.list[0].harness = "reconnecting";
  });
  assertEquals(f.resources.entries()[0].attention.permissions, 1);
  assertEquals(f.resources.entry("local", "session")?.attention.permissions, 1);
  f.resources.stop();
});

Deno.test("server resource tab snapshots detach nested tracking reads and sync only project selections", () => {
  const f = fixture(), p = { sidecarId: "local", directory: "/p" };
  f.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [entry(), entry("other", "/other")],
  });
  f.receive("local", { t: "inbox", inbox: metadata() });
  const snapshot = f.resources.tabSnapshot(p);
  const live = f.resources.inbox("local").state.inbox;
  assertNotStrictEquals(
    snapshot.entries[0],
    f.resources.entry("local", "session"),
  );
  assertNotStrictEquals(
    snapshot.entries[0].attention,
    f.resources.entry("local", "session")!.attention,
  );
  assertNotStrictEquals(snapshot.inbox.tasks[0], live.tasks[0]);
  assertNotStrictEquals(
    snapshot.inbox.tasks[0].sessions,
    live.tasks[0].sessions,
  );
  assertNotStrictEquals(snapshot.inbox.seen, live.seen);
  assertNotStrictEquals(snapshot.inbox.finishes, live.finishes);
  f.receive("local", {
    t: "index.patch",
    rev: 1,
    ops: [{
      op: "upsert",
      entry: {
        ...entry(),
        attention: { ...entry().attention, permissions: 9 },
      },
    }],
  });
  f.receive("local", {
    t: "inbox",
    inbox: { ...metadata(), tasks: [], seen: {}, finishes: {} },
  });
  assertEquals(snapshot.entries[0].attention.permissions, 1);
  assertEquals(snapshot.inbox.tasks[0].sessions, ["session"]);
  assertEquals(snapshot.inbox.seen, { session: 1 });
  assertEquals(snapshot.inbox.finishes, { session: 2 });
  f.resources.syncTabs(p, snapshot, { sidecarId: "local", sessionID: "other" });
  const tabs = f.resources.tabs(p);
  assertEquals(tabs.state.selected, undefined);
  f.resources.syncTabs(p, f.resources.tabSnapshot(p), {
    sidecarId: "local",
    sessionID: "session",
  });
  assertEquals(tabs.state.preview, "session");
  const revision = tabs.state.revision;
  f.resources.syncTabs(p, f.resources.tabSnapshot(p), {
    sidecarId: "local",
    sessionID: "session",
  });
  assertEquals(
    tabs.state.revision,
    revision + 1,
    "already-selected preview is not repeated",
  );
  f.resources.stop();
});

Deno.test("server resource capability policies and RPC ports stay live and server scoped", async () => {
  const f = fixture(), p = { sidecarId: "remote", directory: "/p" };
  assert(f.resources.connected("local") && f.resources.linked("local"));
  assertEquals(f.resources.historySources().map((s) => s.id), [
    "local",
    "remote",
  ]);
  f.store.update((s) => {
    for (const server of s.list) server.status = "connecting";
    s.list[0].connectionVersion = 2;
  });
  assert(!f.resources.advertised("local", "models"));
  assert(f.resources.declares("local", "models"));
  assert(!f.resources.anyAdvertised("history"));
  assertEquals(f.resources.connectionKey("local"), 2);
  assertEquals(f.resources.server("absent"), undefined);
  await f.resources.layout({ leftWidth: 300 });
  await f.resources.inactive(p, true);
  await f.resources.setPreference("theme", "system");
  await f.resources.taskActions(p).add({ id: "task" }, "member");
  assertEquals(await f.resources.add("https://server", "Name"), "added");
  assertEquals(f.calls, [
    ["local", "layout.patch", { leftWidth: 300 }],
    ["remote", "projects.inactive", { directory: "/p", inactive: true }],
    ["local", "prefs.set", { key: "theme", value: "system" }],
    ["remote", "tasks.addSession", { id: "task", sessionID: "member" }],
    ["add", "https://server", "Name"],
  ]);
  const approval = f.resources.approvals("local");
  f.resources.stop();
  f.receive("local", {
    t: "approvals",
    approvals: { enabled: ["session"], revision: 1 },
  });
  assertEquals(
    approval.state.ready,
    false,
    "approvals stop before sidecars",
  );
  assertEquals(f.order, ["sidecars.stop"]);
});
