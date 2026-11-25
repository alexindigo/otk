// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createIndex,
  createServerResources,
  createState,
  lamp,
  SidecarConnection,
  type SidecarState,
} from "@otk/client";
import type { EntityState } from "@otk/protocol";

Deno.test("link loss stales every entity consumer, and reconnect waits for accepted fresh entity publication", () => {
  const servers = createState<{ list: SidecarState[] }>({
    list: [{
      id: "local",
      baseUrl: "",
      label: "Local",
      status: "connected",
      harness: "connected",
      capabilities: [],
      connectionVersion: 1,
    }],
  });
  const connection = new SidecarConnection("http://localhost", {
    status() {},
    frame() {},
  });
  const resources = createServerResources({
    index: createIndex(),
    sidecars: () => ({
      state: servers.state,
      subscribe: servers.subscribe,
      connection: () => connection,
      start() {},
      stop() {},
      add: () => Promise.resolve("local"),
      remove() {},
    }),
  });
  const value: EntityState = {
    kind: "session",
    id: "s",
    state: "working",
    previous: "none",
    counts: { working: 1, blocked: 0, finished: 0, unseen: 0 },
  };
  try {
    resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fresh",
      revision: 0,
      inbox: {
        projects: [],
        tasks: [],
        seen: {},
        finishes: {},
        pathTemplates: [],
        entities: { "session:s": value },
      },
    });
    const store = resources.inbox("local").entities;
    const state = () => lamp(store, "session:s", { now: 0 });
    assertEquals(state(), "working");
    servers.update((s) => s.list[0].status = "reconnecting");
    assertEquals(state(), "none");
    servers.update((s) => s.list[0].status = "connected");
    assertEquals(state(), "none");
    resources.receive("local", {
      t: "inbox.patch",
      generation: "fresh",
      from: 0,
      revision: 1,
      ops: [{ op: "entity.upsert", value }],
    });
    assertEquals(state(), "working");
    servers.update((s) => s.list[0].harness = "reconnecting");
    // The native link is an owner input, not a second browser interpreter:
    // received OTK operations and durable unseen terminals can still be fresh.
    assertEquals(state(), "working");
    resources.receive("local", {
      t: "inbox.patch",
      generation: "fresh",
      from: 1,
      revision: 2,
      ops: [{ op: "entity.upsert", value: { ...value, state: "none" } }],
    });
    assertEquals(state(), "none");
    servers.update((s) => s.list[0].harness = "connected");
    assertEquals(state(), "none");
    resources.receive("local", {
      t: "inbox.patch",
      generation: "fresh",
      from: 2,
      revision: 3,
      ops: [{
        op: "entity.upsert",
        value: { ...value, state: "blocked", cause: "question" },
      }],
    });
    assertEquals(state(), "blocked");
  } finally {
    resources.stop();
  }
});
