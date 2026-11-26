// SPDX-License-Identifier: LGPL-3.0-only
import { sessionEntity } from "./supervision-fixture.ts";
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
  NotificationTriggers,
  SidecarConnection,
  type SidecarState,
  type StateFactory,
} from "@otk/client";
import {
  entityKey,
  type InboxOp,
  type InboxSnapshot,
  type IndexEntry,
  type ProjectStatus,
  type ServerFrame,
} from "@otk/protocol";
import { presentedEntity } from "../entity-state.ts";
/** Decision 62: rows read the project entity the server publishes. */
const projectEntity = (directory: string, state: ProjectStatus): InboxOp => ({
  op: "entity.upsert",
  value: presentedEntity("project", directory, state, state === "finished"),
});
import { DEFAULT_PREFS } from "@otk/protocol";

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
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 1,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}

Deno.test("admitted finishes advance an existing clock silently while live and baseline recovery still complete", () => {
  const f = fixture();
  const completions: number[] = [];
  const origins: unknown[] = [];
  const stop = f.resources.observeEntries("local", (event) => {
    for (const change of event.changes) {
      if (change.completedAt) {
        origins.push([change.completedAt, change.completionOrigin]);
        if (change.completionOrigin !== "historical") {
          completions.push(change.completedAt);
        }
      }
    }
  });
  try {
    f.receive("local", { t: "index.snapshot", rev: 0, entries: [entry()] });
    f.receive("local", {
      t: "inbox.snapshot",
      generation: "finishes",
      revision: 0,
      inbox: { ...metadata(), finishes: { session: 10 } },
    });
    f.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{ op: "evict", id: "session" }],
    });
    f.receive("local", {
      t: "index.patch",
      rev: 2,
      ops: [{ op: "upsert", entry: entry() }],
    });
    completions.length = 0;
    origins.length = 0;
    f.receive("local", {
      t: "inbox.patch",
      generation: "finishes",
      from: 0,
      revision: 1,
      admitted: true,
      ops: [{ op: "finish", sessionID: "session", time: 20 }],
    });
    assertEquals(completions, [], "Lease replay is not a new completion");
    f.receive("local", {
      t: "inbox.patch",
      generation: "finishes",
      from: 1,
      revision: 2,
      ops: [{ op: "finish", sessionID: "session", time: 20 }],
    });
    assertEquals(
      completions,
      [],
      "The silent clock still deduplicates the known finish",
    );
    f.receive("local", {
      t: "inbox.patch",
      generation: "finishes",
      from: 2,
      revision: 3,
      ops: [{ op: "finish", sessionID: "session", time: 30 }],
    });
    assertEquals(completions, [30]);
    f.receive("local", {
      t: "inbox.snapshot",
      generation: "finishes",
      revision: 4,
      inbox: { ...metadata(), finishes: { session: 40 } },
    });
    assertEquals(
      completions,
      [30],
      "Baseline recovery seeds its clock without a fresh alert",
    );
    assertEquals(origins, [[20, "historical"], [30, "live"], [
      40,
      "historical",
    ]]);
  } finally {
    stop();
    f.resources.stop();
  }
});

Deno.test("hierarchy preference reaches every server view before deferred bindings paint", () => {
  const f = fixture((initial) => ({ ...createState(initial), update() {} }));
  const views: { tasksFollowParent?: boolean }[] = [];
  for (const connection of f.connections.values()) {
    connection.view = (view) => {
      views.push(view);
    };
  }
  try {
    f.resources.scope({ sidecarId: "local", directory: "/p" });
    views.length = 0;
    f.receive("local", {
      t: "prefs",
      prefs: { ...DEFAULT_PREFS, tasksFollowParent: true },
    });
    assertEquals(views.length, 2);
    assert(views.every((view) => view.tasksFollowParent === true));
    assertEquals(
      f.resources.tabSnapshot({ sidecarId: "local", directory: "/p" })
        .followParent,
      true,
    );
  } finally {
    f.resources.stop();
  }
});

Deno.test("turning parent-task inheritance off refreshes native hierarchy before a visible child can disappear", async () => {
  const f = fixture(), project = { sidecarId: "local", directory: "/p" };
  const connection = f.connections.get("local")!;
  const originalView = connection.view.bind(connection);
  let current = false;
  connection.view = (view) => {
    current = view.tasksFollowParent ?? false;
    originalView(view);
  };
  const originalCall = connection.rpc.call.bind(connection.rpc),
    readPreferences: boolean[] = [];
  connection.rpc.call = (method, params, options) => {
    if (method === "sessions.list") readPreferences.push(current);
    if (method === "session.get") {
      return Promise.resolve({
        ...entry((params as { sessionID: string }).sessionID, "/foreign"),
        status: "idle",
        attention: {
          permissions: 0,
          questions: 0,
          childPermissions: 0,
          childQuestions: 0,
        },
      }) as never;
    }
    return originalCall(method, params, options);
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const meta = metadata();
  meta.tasks = [{
    id: "foreign",
    directory: "/foreign",
    name: "Foreign task",
    sessions: ["root"],
    order: 0,
  }];
  meta.supervision = {};
  const baseline = () =>
    f.receive("local", {
      t: "inbox.snapshot",
      generation: "hierarchy",
      revision: 0,
      epoch: connection.viewEpoch,
      inbox: meta,
    });
  const reply = (at: number, inherited: boolean) => {
    const read = f.listReads[at];
    read.resolve({
      items: [{
        id: "child",
        parentID: "root",
        directory: project.directory,
        title: "Child",
        timeCreated: 1,
        hierarchy: {
          familyID: "root",
          rootID: "root",
          ancestry: "complete",
          anchorID: "child",
          projectDirectory: project.directory,
          mandatory: false,
          followParent: inherited,
          ...(inherited
            ? { taskID: "foreign", taskDirectory: "/foreign" }
            : {}),
        },
      }],
      older: null,
      load: {
        id: read.intent!.key,
        scope: {
          kind: "project-sessions",
          directory: project.directory,
          query: "",
        },
        boundary: { kind: "page", limit: 20 },
        generation: "native",
        revision: 1,
        state: "complete",
      },
    });
  };
  try {
    f.receive("local", {
      t: "prefs",
      prefs: { ...DEFAULT_PREFS, tasksFollowParent: true },
    });
    f.resources.scope(project);
    baseline();
    f.resources.sessionRows(project);
    assertEquals(f.listReads.length, 1);
    reply(0, true);
    await tick();
    assertEquals(
      f.resources.sessionRows(project).filter((row) => row.kind === "session")
        .map((row) => row.id),
      ["child"],
    );
    f.receive("local", {
      t: "prefs",
      prefs: { ...DEFAULT_PREFS, tasksFollowParent: false },
    });
    assertEquals(
      current,
      false,
      "the new view must precede the hierarchy read",
    );
    assertEquals(
      f.listReads.length,
      2,
      "preference changes replace active cached hierarchy",
    );
    assertEquals(readPreferences, [true, false]);
    meta.tasks = [];
    baseline();
    reply(1, false);
    await tick();
    assertEquals(
      f.resources.sessionRows(project).filter((row) => row.kind === "session")
        .map((row) => [row.id, row.group]),
      [["child", ""]],
    );
  } finally {
    f.resources.stop();
  }
});
Deno.test("live Sessions context overlays preserve creation order when a page row becomes mandatory", async () => {
  const f = fixture(), project = { sidecarId: "local", directory: "/p" };
  const a = {
    ...entry("a"),
    timeCreated: 10,
    status: "idle" as const,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  const b = { ...a, id: "b", timeCreated: 20 };
  const inbox = metadata();
  inbox.tasks = [];
  inbox.finishes = {};
  inbox.seen = {};
  inbox.supervision = {
    a: { state: "none", terminal: 0 },
    b: { state: "none", terminal: 0 },
  };
  try {
    f.receive("local", { t: "index.snapshot", rev: 0, entries: [a, b] });
    f.resources.scope(project);
    const publish = (revision: number) =>
      f.receive("local", {
        t: "inbox.snapshot",
        generation: "creation",
        revision,
        epoch: f.connections.get("local")!.viewEpoch,
        inbox: structuredClone(inbox),
      });
    publish(0);
    f.resources.sessionRows(project);
    const read = f.listReads[0];
    read.resolve({
      items: [a, b],
      older: null,
      load: {
        id: read.intent!.key,
        scope: { kind: "project-sessions", directory: "/p", query: "" },
        boundary: { kind: "page", limit: 20 },
        generation: "native",
        revision: 1,
        state: "complete",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ids = () =>
      f.resources.sessionRows(project).filter((row) => row.kind === "session")
        .map((row) => row.id);
    assertEquals(ids(), ["a", "b"]);
    inbox.supervision!.b = { state: "working", terminal: 0 };
    publish(1);
    assertEquals(ids(), ["a", "b"]);
    inbox.supervision!.a = { state: "needsYou", terminal: 0 };
    publish(2);
    assertEquals(ids(), ["a", "b"]);
  } finally {
    f.resources.stop();
  }
});

function publishOrder(
  f: ReturnType<typeof fixture>,
  id: string,
  directories: (string | string[])[],
  revision = 1,
) {
  f.receive(id, {
    t: "projects.order",
    revision,
    projects: directories.map((directory) => {
      const aliases = typeof directory === "string" ? [directory] : directory;
      return { id: aliases[0], directories: aliases };
    }),
  });
}

Deno.test("sidebar identities stay ordered through state/recency ticks, explicit moves reorder and arrivals append", () => {
  const f = fixture();
  const inbox = metadata();
  inbox.projects.push({ ...inbox.projects[0], directory: "/q" });
  inbox.discovered = ["/new-discovered"];
  const summary = (
    directory: string,
    status: "working" | "blocked" | "finished",
    lastActivity: number,
  ) => ({
    directory,
    status,
    lastActivity,
    sessionCount: 1,
    unseenCount: 0,
    hasSessions: true,
    authority: "current" as const,
  });
  let revision = 0;
  const publish = () =>
    f.receive("local", {
      t: "inbox.snapshot",
      generation: "order",
      revision: revision++,
      inbox: structuredClone(inbox),
    });
  const ids = () =>
    f.resources.projects(Date.now()).filter((row) => row.sidecarId === "local")
      .map((row) => row.directory);
  try {
    inbox.summaries = {
      "/p": summary("/p", "working", 100),
      "/q": summary("/q", "blocked", 1),
    };
    publish();
    assertEquals(ids(), []);
    publishOrder(f, "local", ["/p", "/q", "/new-discovered"]);
    const initial = ids();
    assertEquals(initial, ["/p", "/q", "/new-discovered"]);
    for (const status of ["working", "blocked", "finished"] as const) {
      for (let tick = 0; tick < 10; tick++) {
        inbox.summaries["/q"] = summary("/q", status, 100000 + tick);
        inbox.summaries["/p"] = summary("/p", status, tick);
        publish();
        assertEquals(ids(), initial);
      }
    }
    publishOrder(f, "local", ["/q", "/p", "/new-discovered"], 2);
    assertEquals(ids(), ["/q", "/p", "/new-discovered"]);
    inbox.summaries["/arrival"] = summary("/arrival", "blocked", 9999999);
    publishOrder(f, "local", ["/q", "/p", "/new-discovered", "/arrival"], 3);
    publish();
    assertEquals(ids(), ["/q", "/p", "/new-discovered", "/arrival"]);
    delete inbox.summaries["/q"];
    inbox.projects = inbox.projects.filter((p) => p.directory !== "/q");
    publish();
    assertEquals(ids(), ["/p", "/new-discovered", "/arrival"]);
  } finally {
    f.resources.stop();
  }
});

Deno.test("project order is the durable server and saved order, whichever server answers first after a reload", () => {
  const answer = (
    f: ReturnType<typeof fixture>,
    id: string,
    directories: string[],
  ) => {
    f.receive(id, {
      t: "index.snapshot",
      rev: 0,
      entries: directories.map((d) => entry(`${id}${d}`, d)),
    });
    f.receive(id, {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox: {
        ...metadata(),
        tasks: [],
        projects: [...directories].reverse().map((directory) => ({
          directory,
          lastVisit: 1,
          inactive: false,
          added: true,
        })),
      },
    });
    publishOrder(f, id, directories);
  };
  const order = (f: ReturnType<typeof fixture>) =>
    f.resources.projects(100).map((p) => `${p.sidecarId}:${p.directory}`);
  const expected = [
    "local:/b",
    "local:/a",
    "remote:/d",
    "remote:/c",
  ];
  for (const first of ["local", "remote"]) {
    const f = fixture();
    const servers = { local: ["/b", "/a"], remote: ["/d", "/c"] };
    const second = first === "local" ? "remote" : "local";
    answer(f, first, servers[first as keyof typeof servers]);
    // A render between the answers must not fix arrival order.
    assertEquals(
      order(f),
      expected.filter((row) => row.startsWith(`${first}:`)),
    );
    answer(f, second, servers[second as keyof typeof servers]);
    assertEquals(order(f), expected, `${first} answered first`);
    f.resources.stop();
  }
});

function metadata(): InboxSnapshot {
  return {
    projects: [{
      directory: "/p",
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
    entities: {
      [entityKey("project", "/p")]: presentedEntity("project", "/p", "blocked"),
    },
    pathTemplates: [],
  };
}
function fixture(
  factory?: StateFactory,
  pageReady?: Parameters<typeof createServerResources>[0]["pageReady"],
) {
  const calls: unknown[] = [], order: string[] = [];
  const listReads: {
    input: import("@otk/protocol").SessionListInput;
    intent?: import("../requests.ts").ClientIntent;
    resolve(page: import("@otk/protocol").SessionListPage): void;
  }[] = [];
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
    connection.rpc.call = (method, params, options) => {
      calls.push([id, method, params]);
      if (method === "sessions.identities") {
        return Promise.resolve(
          (params as { ids: string[] }).ids.filter((id) => id === "remembered")
            .map((id) => ({ id, directory: "/unleased" })),
        ) as never;
      }
      if (method === "sessions.list") {
        return new Promise((resolve) => {
          listReads.push({
            input: params as import("@otk/protocol").SessionListInput,
            intent: options && !(options instanceof AbortSignal)
              ? options.intent
              : undefined,
            resolve: resolve as never,
          });
        }) as never;
      }
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
    factory,
    pageReady,
    sidecars: (listener) => {
      receive = listener;
      return sidecars;
    },
  });
  return {
    resources,
    index,
    calls,
    order,
    receive,
    store,
    sidecars,
    connections,
    listReads,
  };
}

Deno.test("catalog page-ready input gates only current-folder warm-up, including project-only routes", async () => {
  const ready: (() => void)[] = [];
  const f = fixture(undefined, (_project, release) => {
    ready.push(release);
  });
  const connection = f.connections.get("local")!;
  connection.rpc.start = (_method, params) =>
    ({
      result: Promise.resolve({
        directory: (params as { directory: string }).directory,
        generation: "g",
        revision: 0,
        paths: { style: "posix", separator: "/" },
        values: Object.fromEntries(
          ["models", "agents", "commands", "skills", "files", "resources"].map((
            kind,
          ) => [kind, { state: "digesting", revision: 0 }]),
        ),
      }),
      release() {},
    }) as never;
  f.store.update((state) => {
    state.list[0].capabilities = ["catalogs"];
  });
  const settle = async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
  };
  const demands = () =>
    f.calls.filter((call) => (call as unknown[])[1] === "catalogs.demand");
  try {
    f.resources.scope({ sidecarId: "local", directory: "/p" });
    await settle();
    assertEquals(demands(), []);
    ready[0]();
    await settle();
    assertEquals(demands(), [["local", "catalogs.demand", {
      directory: "/p",
      kinds: ["models", "agents", "commands", "skills"],
      intent: "warm",
    }]]);
    // A same-folder session visit borrows the resource without another release point.
    f.resources.scope({ sidecarId: "local", directory: "/p" }, ["session"]);
    await settle();
    assertEquals(ready.length, 1);
    assertEquals(demands().length, 1);
    f.resources.scope({ sidecarId: "local", directory: "/other" });
    await settle();
    ready[0](); // Retired page-ready callbacks cannot warm the wrong folder.
    await settle();
    assertEquals(demands().length, 1);
    ready[1]();
    await settle();
    assertEquals((demands()[1] as unknown[])[2], {
      directory: "/other",
      kinds: ["models", "agents", "commands", "skills"],
      intent: "warm",
    });
    // Navigation may display the repository while the selected composer uses a
    // nested native folder. The same release input follows that actual folder.
    f.receive("local", {
      t: "index.snapshot",
      rev: 0,
      entries: [entry("nested", "/other/src")],
    });
    f.resources.scope({ sidecarId: "local", directory: "/other" }, [], {
      sidecarId: "local",
      sessionID: "nested",
    });
    await settle();
    assertEquals(ready.length, 3);
    ready[2]();
    await settle();
    assertEquals((demands()[2] as unknown[])[2], {
      directory: "/other/src",
      kinds: ["models", "agents", "commands", "skills"],
      intent: "warm",
    });
    f.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{ op: "upsert", entry: entry("nested", "/other/moved") }],
    });
    await settle();
    assertEquals(ready.length, 4);
    ready[3]();
    await settle();
    assertEquals((demands()[3] as unknown[])[2], {
      directory: "/other/moved",
      kinds: ["models", "agents", "commands", "skills"],
      intent: "warm",
    });
  } finally {
    f.resources.stop();
  }
});

Deno.test("leaf Sessions demand keeps bounded exact native scopes and projects nested idle rows and tasks without a flat project", async () => {
  const f = fixture(), project = { sidecarId: "local", directory: "/tree" };
  const inbox: InboxSnapshot = {
    projects: [],
    tasks: [{
      id: "nested-task",
      directory: "/tree/src",
      name: "Nested",
      order: 0,
      sessions: ["tstv1-idle"],
    }],
    seen: {},
    finishes: {},
    pathTemplates: [],
    summaries: {
      "/tree": {
        directory: "/tree",
        status: "none",
        hasSessions: true,
        sessionCount: 1,
        unseenCount: 0,
        lastActivity: 1,
        authority: "current",
        scopes: ["/tree", "/tree/src"],
        topology: {
          repoID: "repo",
          canonicalRoot: "/repo",
          leafDirectory: "/tree",
          parentDirectory: "/repo",
        },
      },
    },
  };
  f.resources.scope(project);
  f.receive("local", {
    t: "inbox.snapshot",
    generation: "g",
    revision: 0,
    summaryRevision: 0,
    epoch: f.connections.get("local")!.viewEpoch,
    inbox,
  });
  f.resources.sessionRows(project);
  assertEquals(f.listReads.map((r) => r.input.directory), [
    "/tree",
    "/tree/src",
  ]);
  for (const read of f.listReads) {
    read.resolve({
      items: read.input.directory === "/tree/src"
        ? [{
          id: "tstv1-idle",
          directory: "/tree/src",
          title: "Idle nested",
          timeCreated: 1,
        }]
        : [],
      older: null,
      load: {
        id: read.intent!.key,
        scope: {
          kind: "project-sessions",
          directory: read.input.directory,
          query: "",
        },
        boundary: { kind: "page", limit: 20 },
        generation: "native",
        revision: 1,
        state: "complete",
      },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(
    f.resources.sessionRows(project).filter((r) => r.kind === "session").map((
      r,
    ) => [r.id, r.group]),
    [["tstv1-idle", "nested-task"]],
  );
  publishOrder(f, "local", [["/tree", "/tree/src"]]);
  assertEquals(f.resources.projects(0).map((r) => r.directory), ["/tree"]);
  assertEquals(inbox.tasks[0].directory, "/tree/src");
  assertEquals(f.resources.tabs(project).tasks()[0].directory, "/tree/src");
  await f.resources.taskActions(project).reorder(["nested-task"]);
  assert(
    f.calls.some((call) =>
      JSON.stringify(call) ===
        JSON.stringify(["local", "tasks.reorder", {
          directory: "/tree/src",
          ids: ["nested-task"],
        }])
    ),
  );
  f.resources.stop();
});

Deno.test("project acquisition delegates default selection without a client identity or list fallback", async () => {
  const f = fixture(), p = { sidecarId: "local", directory: "/unleased" };
  const calls: unknown[] = [];
  f.connections.get("local")!.rpc.call = (method, params) => {
    calls.push([method, params]);
    return Promise.resolve(
      (params as { preferred?: string }).preferred === "remembered"
        ? "remembered"
        : null,
    ) as never;
  };
  assertEquals(await f.resources.projectSession(p, "remembered"), "remembered");
  assertEquals(await f.resources.projectSession(p, "missing"), undefined);
  assertEquals(
    calls,
    ["remembered", "missing"].map((
      preferred,
    ) => ["navigation.default", { directory: p.directory, preferred }]),
  );
  assertEquals(f.listReads.length, 0);
  f.resources.stop();
});

Deno.test("Sessions hierarchy waits for its requested page and coherent inbox but survives same-project row lease churn", async () => {
  const f = fixture(), project = { sidecarId: "local", directory: "/p" };
  f.resources.scope(project);
  const epoch = f.connections.get("local")!.viewEpoch;
  assertEquals(f.resources.sessionRowsReady(project), false);
  f.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: metadata(),
    epoch: epoch - 1,
  });
  const read = f.listReads[0];
  read.resolve({
    items: [{
      id: "session",
      title: "Session",
      directory: "/p",
      timeCreated: 1,
    }],
    older: "page-2",
    load: {
      id: read.intent!.key,
      scope: { kind: "project-sessions", directory: "/p" },
      boundary: { kind: "page", limit: 20 },
      generation: "source",
      revision: 1,
      state: "complete",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(f.resources.sessionRowsReady(project), false);
  f.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: metadata(),
    epoch,
  });
  assertEquals(f.resources.sessionRowsReady(project), true);
  assertEquals(f.resources.sessionRows(project)[0].key, "heading:task");
  f.resources.visibleRows(project, ["session"]);
  assertEquals(f.resources.sessionRowsReady(project), true);
  const other = { ...project, directory: "/other" };
  f.resources.scope(other);
  assertEquals(f.resources.sessionRowsReady(other), false);
  assertEquals(
    f.resources.sessionRowsReady(project),
    true,
    "same-directory retained inbox and page remain coherent",
  );
  f.resources.stop();
});

Deno.test("mandatory and task context paints with a coherent inbox while its list boundary is still loading", () => {
  const f = fixture(), project = { sidecarId: "local", directory: "/p" };
  f.resources.scope(project);
  const epoch = f.connections.get("local")!.viewEpoch;
  f.receive("local", {
    t: "index.snapshot",
    epoch,
    rev: 0,
    entries: [entry()],
  });
  f.receive("local", {
    t: "inbox.snapshot",
    epoch,
    generation: "fixture",
    revision: 0,
    inbox: metadata(),
  });
  assertEquals(f.resources.sessionRowsReady(project), true);
  assertEquals(f.resources.sessionRowsLoading(project), true);
  assert(f.resources.sessionRows(project).some((row) => row.key === "session"));
  f.resources.stop();
});

Deno.test("@load @sessions digest-only patches do zero project-row recomputations and zero attention-map rebuilds", () => {
  const revisions: { revision: number }[] = [];
  const factory: StateFactory = (initial) => {
    if ("revision" in initial && "keys" in initial) {
      revisions.push(initial as { revision: number });
    }
    return createState(initial);
  };
  const f = fixture(factory);
  publishOrder(f, "local", ["/p", "/other"]);
  f.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [entry(), entry("other", "/other")],
  });
  f.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: metadata(),
  });
  f.receive("local", {
    t: "approvals",
    approvals: { enabled: ["session"], revision: 1 },
  });
  const rows = f.resources.projects(100);
  const metadataRows = f.resources.metadataEntries();
  let attentionBuilds = 0;
  const requests = f.connections.get("local")!.rpc.requests;
  const operations = requests.operations.bind(requests);
  requests.operations = () => {
    attentionBuilds++;
    return operations();
  };
  const before = revisions.map((r) => r.revision);
  f.receive("local", {
    t: "index.patch",
    rev: 1,
    ops: [{
      op: "digest",
      id: "session",
      revision: 1,
      summary: { state: "ready", revision: 1 },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    }],
  });
  const after = f.resources.projects(100);
  f.resources.metadataEntries();
  f.resources.tabSnapshot({ sidecarId: "local", directory: "/p" });
  assertEquals(
    revisions.map((r) => r.revision),
    before,
    "owner revisions count project-row recomputations",
  );
  assertEquals(attentionBuilds, 0, "the request attention map is not rebuilt");
  after.forEach((row, i) => assertStrictEquals(row, rows[i]));
  f.resources.metadataEntries().forEach((row, i) =>
    assertStrictEquals(row, metadataRows[i])
  );
  assertEquals(f.resources.entry("local", "session")?.digest.state, "ready");
  const upsert = structuredClone(f.resources.entry("local", "session")!);
  upsert.digest.revision = 2;
  f.receive("local", {
    t: "index.patch",
    rev: 2,
    ops: [{ op: "upsert", entry: upsert }],
  });
  f.resources.projects(100);
  assertEquals(revisions.map((r) => r.revision), before);
  assertEquals(attentionBuilds, 0);
  f.resources.stop();
});

Deno.test("project keys maintain membership, lamps, unread, name collisions and unaffected row identity", () => {
  const f = fixture();
  const a = {
    ...entry("a", "/one/shared"),
    status: "idle" as const,
    attention: { ...entry().attention, permissions: 0 },
  };
  const b = { ...a, id: "b", directory: "/two/shared" };
  publishOrder(f, "local", [a.directory, b.directory, "/empty"]);
  f.receive("local", { t: "index.snapshot", rev: 0, entries: [a, b] });
  f.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: {
      ...metadata(),
      projects: [],
      tasks: [],
      seen: {},
      finishes: { a: 2 },
      entities: {
        [entityKey("project", a.directory)]: presentedEntity(
          "project",
          a.directory,
          "finished",
          true,
        ),
      },
      discovered: ["/empty"],
    },
  });
  const rows = f.resources.projects(100),
    other = rows.find((r) => r.directory === b.directory)!;
  assertEquals(f.resources.duplicateProjectName("shared"), true);
  assertEquals(
    rows.find((r) => r.directory === a.directory)?.status,
    "finished",
  );
  assertEquals(rows.find((r) => r.directory === a.directory)?.sessionCount, 1);
  f.receive("local", {
    t: "inbox.patch",
    generation: "fixture",
    from: 0,
    revision: 3,
    ops: [{ op: "seen", sessionID: "a", time: 3 }, {
      op: "entity.upsert",
      value: sessionEntity("a", { state: "none", terminal: 2 }),
    }, projectEntity(a.directory, "none")],
  });
  assertEquals(
    f.resources.projectRow({ sidecarId: "local", directory: a.directory }, 100)
      ?.status,
    "none",
  );
  assertStrictEquals(
    f.resources.projects(100).find((r) => r.directory === b.directory),
    other,
  );
  publishOrder(f, "local", [[a.directory, "/moved"], b.directory, "/empty"], 2);
  f.receive("local", {
    t: "index.patch",
    rev: 1,
    ops: [{
      op: "upsert",
      entry: { ...a, directory: "/moved", status: "busy" },
    }],
  });
  const moved = f.resources.projects(100);
  f.receive("local", {
    t: "inbox.patch",
    generation: "fixture",
    from: 3,
    revision: 5,
    ops: [{
      op: "entity.upsert",
      value: sessionEntity("a", { state: "working", terminal: 2 }),
    }, projectEntity("/moved", "working")],
  });
  const currentMoved = f.resources.projects(100);
  assertEquals(moved.some((r) => r.directory === a.directory), false);
  assertEquals(f.resources.duplicateProjectName("shared"), false);
  assertEquals(moved.find((r) => r.directory === "/moved")?.sessionIDs, "a");
  assertEquals(
    currentMoved.find((r) => r.directory === "/moved")?.status,
    "working",
  );
  f.receive("local", {
    t: "index.patch",
    rev: 2,
    ops: [{ op: "remove", id: "a" }],
  });
  assertEquals(
    f.resources.projects(100).some((r) => r.directory === "/moved"),
    false,
  );
  f.resources.stop();
});

Deno.test("duplicate checkout hints follow native project name publications", () => {
  const f = fixture();
  const a = "/one/shared", b = "/two/shared";
  f.receive("local", {
    t: "inbox.snapshot",
    generation: "names",
    revision: 0,
    inbox: metadata(),
  });
  const summary = (directory: string, name?: string) => ({
    directory,
    presentation: { id: directory, name },
    hasSessions: true,
    status: null,
    sessionCount: 1,
    unseenCount: 0,
    lastActivity: null,
    authority: "current" as const,
  });
  const publish = (from: number, ...summaries: ReturnType<typeof summary>[]) =>
    f.receive("local", {
      t: "inbox.summaries",
      generation: "names",
      from,
      revision: from + summaries.length,
      summaries,
    });
  publish(0, summary(a), summary(b));
  assertEquals(f.resources.duplicateProjectName("shared"), true);
  publish(2, summary(a, "Shared app"));
  assertEquals(f.resources.duplicateProjectName("shared"), false);
  assertEquals(f.resources.duplicateProjectName("Shared app"), false);
  publish(3, summary(b, "Shared app"));
  assertEquals(f.resources.duplicateProjectName("Shared app"), true);
});

Deno.test("keyed project attention follows operation lifetimes, task membership, policy and native link", () => {
  const f = fixture();
  const session = {
    ...entry(),
    status: "idle" as const,
    attention: { ...entry().attention, permissions: 0 },
  };
  f.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [session, { ...session, id: "other" }],
  });
  f.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: { ...metadata(), finishes: {}, supervision: {}, entities: {} },
  });
  const p = { sidecarId: "local", directory: "/p" };
  f.resources.projects(100);
  const rpc = f.connections.get("local")!.rpc;
  rpc.requests.connect({ id: "window", expiresAt: Date.now() + 60_000 }, 64);
  const operation = rpc.start("session.rename", {
    sessionID: "session",
    title: "New",
  }, { owner: "task" });
  void operation.result.catch(() => {});
  // An operation not yet received remains in its request owner, not in any lamp.
  assertEquals(f.resources.projectRow(p, 100)?.status, "none");
  assertEquals(
    f.resources.inbox("local").entities.get("session:session"),
    undefined,
  );
  f.receive("local", {
    t: "inbox.patch",
    generation: "fixture",
    from: 0,
    revision: 1,
    ops: [{
      op: "task.upsert",
      task: { ...metadata().tasks[0], sessions: ["other"] },
    }],
  });
  assertEquals(
    f.resources.inbox("local").entities.get("session:other"),
    undefined,
  );
  rpc.receive({
    t: "request.result",
    ref: operation.state.ref,
    seq: 1,
    outcome: { ok: true, result: null },
  });
  assertEquals(f.resources.projectRow(p, 100)?.status, "none");
  f.receive("local", {
    t: "index.patch",
    rev: 1,
    ops: [{
      op: "upsert",
      entry: {
        ...session,
        attention: { ...session.attention, permissions: 1 },
      },
    }],
  });
  f.receive("local", {
    t: "inbox.patch",
    generation: "fixture",
    from: 1,
    revision: 3,
    ops: [{
      op: "entity.upsert",
      value: sessionEntity("session", { state: "needsYou", terminal: 0 }),
    }, projectEntity("/p", "blocked")],
  });
  assertEquals(f.resources.projectRow(p, 100)?.status, "blocked");
  f.receive("local", {
    t: "approvals",
    approvals: { enabled: ["session"], revision: 1 },
  });
  f.receive("local", {
    t: "inbox.patch",
    generation: "fixture",
    from: 3,
    revision: 5,
    ops: [{
      op: "entity.upsert",
      value: sessionEntity("session", { state: "none", terminal: 0 }),
    }, projectEntity("/p", "none")],
  });
  assertEquals(f.resources.projectRow(p, 100)?.status, "none");
  f.store.update((state) => {
    state.list[0].harness = "reconnecting";
  });
  assertEquals(f.resources.projectRow(p, 100)?.status, "none");
  f.resources.stop();
});

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
  f.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: metadata(),
  });
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
    f.receive(id, {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox: metadata(),
    });
  }
  f.receive("local", {
    t: "approvals",
    approvals: { enabled: ["session"], revision: 0 },
  });
  assertEquals(
    f.resources.entries().map((e) => [e.sidecarId, e.attention.permissions]),
    [["local", 1], ["remote", 1]],
  );
  f.receive("local", {
    t: "inbox.patch",
    generation: "fixture",
    from: 0,
    revision: 2,
    ops: [{
      op: "entity.upsert",
      value: sessionEntity("session", { state: "working", terminal: 2 }),
    }, projectEntity("/p", "working")],
  });
  assertEquals(
    f.resources.projectEntries({ sidecarId: "local", directory: "/other" }),
    [],
  );
  publishOrder(f, "local", ["/p"]);
  publishOrder(f, "remote", ["/p"]);
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

Deno.test("server resource tabs cache semantic snapshots while commands and sync borrow invocation-current metadata", () => {
  const f = fixture(), p = { sidecarId: "local", directory: "/p" };
  f.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [entry(), entry("other", "/other")],
  });
  f.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: metadata(),
  });
  const snapshot = f.resources.tabSnapshot(p);
  const live = f.resources.inbox("local").state.inbox;
  assertStrictEquals(
    snapshot.entries[0].attention,
    f.resources.entry("local", "session")!.attention,
  );
  assertEquals(snapshot.inbox.tasks[0], live.tasks[0]);
  assertEquals(snapshot.inbox.seen, live.seen);
  assertEquals(snapshot.inbox.finishes, live.finishes);
  assertStrictEquals(snapshot, f.resources.tabSnapshot(p));
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
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: { ...metadata(), tasks: [], seen: {}, finishes: {} },
  });
  const current = f.resources.tabSnapshot(p);
  assertNotStrictEquals(current, snapshot);
  assertEquals(current.entries[0].attention.permissions, 9);
  assertEquals(current.inbox.tasks, []);
  assertEquals(current.inbox.seen, {});
  assertEquals(current.inbox.finishes, {});
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
    revision,
    "unchanged inputs and already-selected preview publish no invalidation",
  );
  f.resources.stop();
});

Deno.test("shared projected deltas preserve manual sibling notes and fence rejected index gaps", () => {
  const f = fixture(), notes: string[] = [], changes: string[][] = [];
  const trigger = new NotificationTriggers(
    (note) => notes.push(note.kind),
    () => {},
  );
  const stop = f.resources.observeEntries("local", (change) => {
    changes.push(change.changes.map((entry) => entry.id));
    trigger.entriesChanged("local", change);
  });
  const root = {
    ...entry("root"),
    attention: { ...entry().attention, permissions: 0, childPermissions: 0 },
  };
  const auto = {
    ...entry("auto"),
    parentID: "root",
    attention: { ...entry().attention, permissions: 0 },
  };
  const manual = {
    ...entry("manual"),
    parentID: "root",
    attention: { ...entry().attention, permissions: 0 },
  };
  f.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [root, auto, manual],
  });
  f.receive("local", {
    t: "approvals",
    approvals: { enabled: ["auto"], revision: 0 },
  });
  f.receive("local", {
    t: "inbox.snapshot",
    generation: "manual",
    revision: 0,
    inbox: { ...metadata(), entities: {} },
  });
  notes.length = changes.length = 0;
  f.receive("local", {
    t: "index.patch",
    rev: 3,
    ops: [
      {
        op: "upsert",
        entry: {
          ...root,
          attention: { ...root.attention, childPermissions: 2 },
        },
      },
      {
        op: "upsert",
        entry: { ...auto, attention: { ...auto.attention, permissions: 1 } },
      },
      {
        op: "upsert",
        entry: {
          ...manual,
          attention: { ...manual.attention, permissions: 1 },
        },
      },
    ],
  });
  assertEquals(notes, []);
  const manualState = sessionEntity("manual", {
    state: "needsYou",
    terminal: 0,
  });
  manualState.evidence!.permissions = 1;
  manualState.evidence!.requests = {
    permissions: [{ id: "permission/manual" }],
    questions: [],
  };
  f.receive("local", {
    t: "inbox.patch",
    generation: "manual",
    from: 0,
    revision: 1,
    ops: [{ op: "entity.upsert", value: manualState }],
  });
  assertEquals(notes, ["permission"]);
  const count = changes.length;
  f.receive("local", {
    t: "index.patch",
    rev: 99,
    ops: [{ op: "upsert", entry: { ...root, status: "idle" } }],
  });
  assertEquals(
    changes.length,
    count,
    "a rejected gap cannot reach the projection or notifications",
  );
  assertEquals(
    f.resources.projected("local", "manual")?.attention.permissions,
    1,
  );
  assertEquals(
    f.resources.projected("local", "auto")?.attention.permissions,
    0,
  );
  stop();
  f.resources.stop();
});

Deno.test("server resource capability policies and RPC ports stay live and server scoped", async () => {
  const f = fixture(), p = { sidecarId: "remote", directory: "/p" };
  assert(f.resources.connected("local") && f.resources.linked("local"));
  assertEquals(f.resources.historySources(), []);
  f.resources.scope(p);
  assertEquals(f.resources.historySources().map((s) => s.id), ["remote"]);
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
