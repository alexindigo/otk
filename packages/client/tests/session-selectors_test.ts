// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  type ClientSession,
  createIndex,
  createTranscripts,
  createTranscriptScopes,
  SidecarConnection,
} from "@otk/client";
import type { ClientFrame, Message } from "@otk/protocol";
import { shellEntry, shellFixture, shellTask } from "./shell-fixture.ts";
import {
  connectRequests,
  replyRequest,
} from "../../../tests/support/request-wire.ts";
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../../tests/support/message-pages.ts";

Deno.test("@load @sessions digest-only and unrelated-project patches do zero tab/crumb/Sessions derivation work", () => {
  const f = shellFixture(), project = { sidecarId: "local", directory: "/p" };
  f.resources.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [
      shellEntry("a"),
      shellEntry("helper", "/p", "a"),
      shellEntry("other", "/q"),
    ],
  });
  f.resources.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: {
      projects: [],
      tasks: [shellTask("task", ["a"])],
      seen: {},
      finishes: {},
      pathTemplates: [],
    },
  });
  const tabs = f.resources.tabs(project);
  tabs.preview("a");
  const initial = {
    tabs: tabs.tabs(),
    crumbs: tabs.crumbs(),
    rows: f.resources.sessionRows(project),
    metadata: f.resources.projectMetadata(project),
  };
  let inputChanges = 0, tabBuilds = 0, crumbBuilds = 0, rowBuilds = 0;
  const release = tabs.subscribe(() => inputChanges++);
  // Test-side getter counters observe any population walk, including one whose
  // result is subsequently discarded. No instrumentation enters product code.
  let reads = 0;
  for (const entry of initial.metadata) {
    for (const key of ["title", "parentID", "status"] as const) {
      const value = entry[key];
      Object.defineProperty(entry, key, {
        configurable: true,
        get() {
          reads++;
          return value;
        },
      });
    }
  }
  const sample = () => {
    const input = f.resources.tabSnapshot(project);
    f.resources.syncTabs(project, input, {
      sidecarId: "local",
      sessionID: "a",
    });
    if (tabs.tabs() !== initial.tabs) tabBuilds++;
    if (tabs.crumbs() !== initial.crumbs) crumbBuilds++;
    if (f.resources.sessionRows(project) !== initial.rows) rowBuilds++;
    assertStrictEquals(f.resources.projectMetadata(project), initial.metadata);
  };
  try {
    f.resources.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{
        op: "digest",
        id: "a",
        revision: 1,
        summary: { state: "ready", revision: 1 },
        turns: { upsert: {}, remove: [] },
        deleted: null,
      }],
    });
    reads = 0;
    sample();
    assertEquals(reads, 0);
    f.resources.receive("local", {
      t: "index.patch",
      rev: 2,
      ops: [{
        op: "upsert",
        entry: {
          ...shellEntry("other", "/q"),
          title: "Renamed elsewhere",
          status: "busy",
        },
      }],
    });
    reads = 0;
    sample();
    assertEquals(reads, 0);
    f.resources.receive("local", {
      t: "inbox.patch",
      generation: "fixture",
      from: 0,
      revision: 1,
      ops: [{
        op: "task.upsert",
        task: shellTask("elsewhere", ["other"], "/q"),
      }],
    });
    reads = 0;
    sample();
    assertEquals(reads, 0);
    assertEquals({ inputChanges, tabBuilds, crumbBuilds, rowBuilds }, {
      inputChanges: 0,
      tabBuilds: 0,
      crumbBuilds: 0,
      rowBuilds: 0,
    });
  } finally {
    release();
    f.resources.stop();
  }
});

Deno.test("selecting a task reads only the selected transcript and its visible page, never family or cross-project bodies", async () => {
  const f = shellFixture(),
    reads: Extract<ClientFrame, { t: "request" }>[] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  connection.send = (frame) => {
    if (frame.t === "request") reads.push(frame);
  };
  connection.subscribe = () => {};
  connectRequests(connection.rpc);
  const bodies = createTranscripts({
    connection: () => connection,
    entry: (server, id) => f.resources.entry(server, id),
  });
  const session = {
    demand: bodies.setDemand,
    transcripts: bodies,
  } as unknown as ClientSession;
  const scopes = createTranscriptScopes({ resources: f.resources, session });
  const turns = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };
  const messages: Message[] = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`,
    sessionID: "a",
    role: "user",
    time: { created: i },
    parts: [{
      id: `p${i}`,
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: `Selected ${i}` }],
      }],
    }],
  }));
  const reply = async () => {
    const request = reads.at(-1)!;
    const params = request.params as { sessionID: string; before?: string };
    assertEquals(request.method, "session.messages");
    replyRequest(
      connection.rpc,
      request,
      fixturePage(params.sessionID, messages, params.before),
    );
    await turns();
  };
  try {
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 0,
      entries: [shellEntry("a"), shellEntry("sibling"), {
        ...shellEntry("helper", "/p", "a"),
        status: "busy",
      }, { ...shellEntry("foreign", "/q"), status: "busy" }],
    });
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 0,
      inbox: {
        projects: [],
        tasks: [shellTask("task", ["a", "sibling"])],
        seen: {},
        finishes: {},
        pathTemplates: [],
      },
    });
    scopes.update({
      project: { sidecarId: "local", directory: "/p" },
      selected: { sidecarId: "local", sessionID: "a" },
      screen: true,
    });
    await turns();
    assertEquals(reads.length, 1);
    await reply();
    assertEquals(
      reads.length,
      2,
      "newest ten, then the selected session's reserve",
    );
    await reply();
    const selected = bodies.get({ sidecarId: "local", sessionID: "a" })!;
    assertEquals(selected.state.messageIDs.length, 20);
    assertEquals(selected.state.messagesByID.m39.parts, messages[39].parts);
    const older = selected.older();
    await turns();
    await reply();
    await older;
    assertEquals(selected.state.messageIDs.length, 30);
    assertEquals(
      new Set(reads.map((r) => (r.params as { sessionID: string }).sessionID)),
      new Set(["a"]),
    );
    assertEquals(
      ["sibling", "helper", "foreign"].map((sessionID) =>
        bodies.get({ sidecarId: "local", sessionID })
      ),
      [undefined, undefined, undefined],
    );
  } finally {
    scopes.stop();
    bodies.stop();
    connection.rpc.close();
    f.resources.stop();
  }
});

Deno.test("partition progress includes retained summaries throughout refresh lifetimes", () => {
  const index = createIndex();
  const entry = (id: string, directory = "/p") => ({
    ...shellEntry(id, directory),
    digest: {
      state: "ready" as const,
      refreshing: true,
      revision: 1,
      turns: {},
    },
  });
  const busy = { busy: true, announcement: "" };
  const ready = { busy: false, announcement: "Session summaries updated." };
  index.receive("s", {
    t: "index.snapshot",
    rev: 0,
    entries: [entry("a"), entry("b")],
  });
  assertEquals(index.progress("s", "/p"), busy);
  index.receive("s", {
    t: "index.patch",
    rev: 1,
    ops: [{
      op: "upsert",
      entry: {
        ...entry("a"),
        digest: { ...entry("a").digest, state: "digesting" },
      },
    }],
  });
  index.receive("s", {
    t: "index.patch",
    rev: 2,
    ops: [{
      op: "digest",
      id: "a",
      revision: 2,
      summary: { state: "ready", refreshing: false, revision: 2 },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    }],
  });
  assertEquals(index.progress("s", "/p"), busy);
  index.receive("s", {
    t: "index.patch",
    rev: 3,
    ops: [{ op: "upsert", entry: entry("b", "/q") }],
  });
  assertEquals(index.progress("s", "/p"), ready);
  assertEquals(index.progress("s", "/q"), busy);
  index.receive("s", {
    t: "index.snapshot",
    rev: 4,
    entries: [entry("a")],
  });
  assertEquals(index.progress("s", "/p"), busy);
  assertEquals(index.progress("s", "/q"), { busy: false, announcement: "" });
  index.receive("s", {
    t: "index.patch",
    rev: 5,
    ops: [{
      op: "digest",
      id: "a",
      revision: 3,
      summary: { state: "unavailable", refreshing: false, revision: 3 },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    }],
  });
  assertEquals(index.progress("s", "/p"), ready);
  index.receive("s", {
    t: "index.patch",
    rev: 6,
    ops: [{ op: "remove", id: "a" }],
  });
  assertEquals(index.progress("s", "/p"), { busy: false, announcement: "" });
});

Deno.test("partition caching and incremental progress follow digest transitions, moves, removals and reordered snapshots", () => {
  const index = createIndex();
  index.receive("s", {
    t: "index.snapshot",
    rev: 0,
    entries: [shellEntry("a"), shellEntry("b"), shellEntry("other", "/q")],
  });
  const entries = index.partition("s", "/p"),
    other = index.partition("s", "/q");
  assertStrictEquals(index.partition("s", "/p"), entries);
  const progress = index.progress("s", "/p");
  assertEquals(progress.busy, true);
  index.receive("s", {
    t: "index.patch",
    rev: 1,
    ops: [{
      op: "upsert",
      entry: {
        ...shellEntry("a"),
        digest: { state: "ready", revision: 1, turns: {} },
      },
    }],
  });
  assertStrictEquals(index.partition("s", "/q"), other);
  assertStrictEquals(
    index.progress("s", "/p"),
    progress,
    "one remaining digest keeps the same semantic progress clock",
  );
  index.receive("s", {
    t: "index.snapshot",
    rev: 2,
    entries: [shellEntry("b"), {
      ...shellEntry("a"),
      digest: { state: "ready", revision: 1, turns: {} },
    }, shellEntry("other", "/q")],
  });
  assertEquals(index.progress("s", "/p").busy, true);
  index.receive("s", {
    t: "index.patch",
    rev: 3,
    ops: [{ op: "upsert", entry: shellEntry("b", "/q") }],
  });
  assertEquals(index.progress("s", "/p"), {
    busy: false,
    announcement: "Session summaries updated.",
  });
  index.receive("s", {
    t: "index.patch",
    rev: 4,
    ops: [{ op: "remove", id: "a" }],
  });
  assertEquals(index.progress("s", "/p"), { busy: false, announcement: "" });
});
