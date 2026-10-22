// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  type ClientSession,
  createCurrentClient,
  createIndex,
  createServerResources,
  createSessionActions,
  emptyContent,
  SidecarConnection,
  type SidecarsState,
} from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import { sessionPorts } from "../shell/session-ports.ts";

Deno.test("session ports capture target once while capability and resource getters stay live", async () => {
  const calls: unknown[] = [];
  const state: SidecarsState = {
    list: ["local", "remote"].map((id) => ({
      id,
      baseUrl: "",
      label: id,
      status: "connected",
      harness: "connected",
      capabilities: id === "local" ? ["models"] : ["history"],
      connectionVersion: 1,
    })),
  };
  const connections = new Map(state.list.map((s) => {
    const connection = new SidecarConnection("http://127.0.0.1:1502", {
      status() {},
      frame() {},
    });
    connection.rpc.call = (method, params) => {
      calls.push([s.id, method, params]);
      return Promise.resolve(null) as never;
    };
    return [s.id, connection] as const;
  }));
  const index = createIndex();
  index.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [{
      id: "original",
      directory: "/original",
      title: "Title",
      projectID: "p",
      status: "idle",
      archived: false,
      timeCreated: 1,
      timeUpdated: 2,
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    }],
  });
  const resources = createServerResources({
    index,
    sidecars: () => ({
      state,
      subscribe: () => () => {},
      connection: (id) => connections.get(id)!,
      start() {},
      stop() {},
      add: () => Promise.resolve("added"),
      remove() {},
    }),
  });
  const target = { sidecarId: "local", sessionID: "original" };
  const session = {
    state: {
      selection: target,
      content: emptyContent(),
      siblings: [],
      loading: false,
      paging: false,
      exhausted: false,
    },
    models: undefined,
    onToolCompleted: () => () => {},
  } as unknown as ClientSession;
  const actions = createSessionActions({
    resources,
    session,
    current: createCurrentClient(
      () => session.state.selection,
      (id) => connections.get(id)!,
    ),
  });
  const dirty: unknown[] = [];
  const ports = sessionPorts({
    target,
    resources,
    actions,
    session,
    guard: { mark: (owner, value) => dirty.push([owner, value]) },
    prefs: () => DEFAULT_PREFS,
  });
  target.sessionID = "mutated";
  session.state.selection = { sidecarId: "remote", sessionID: "newer" };
  assertEquals(ports.sessionID(), "original");
  assertEquals(await ports.directory(), "/original");
  await ports.rpc("session.abort", { sessionID: ports.sessionID() });
  await ports.act(() => Promise.resolve());
  assertEquals(calls, [["local", "session.abort", { sessionID: "original" }], [
    "local",
    "projects.visit",
    { directory: "/original" },
  ]]);
  assertEquals([ports.supports("history"), ports.supports("models")], [
    true,
    true,
  ]);
  state.list[0].status = "reconnecting";
  state.list[1].status = "reconnecting";
  state.list[0].connectionVersion = 2;
  assertEquals([
    ports.supports("history"),
    ports.supports("models"),
    ports.connected!(),
    ports.connectionKey!(),
  ], [false, true, false, 2]);
  state.list[0].capabilities = [];
  assertEquals(ports.supports("models"), false);
  ports.dirty("permissions", true);
  assertEquals(dirty, [["permissions", true]]);
  assertStrictEquals(ports.prefs(), DEFAULT_PREFS);
  resources.stop();
});
