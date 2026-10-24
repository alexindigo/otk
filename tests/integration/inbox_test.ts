// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createInbox, inboxProjects, SidecarConnection } from "@otk/client";
import type { InboxSnapshot } from "@otk/protocol";
import { coreBackendFixture } from "../support/core-backend.ts";
import { cfg, fixture } from "../support/config.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";
import { startApplication } from "../../application.ts";

async function consumer(url: string) {
  let latest: InboxSnapshot | undefined, socket: WebSocket | undefined;
  const connection = new SidecarConnection(url, {
    status() {},
    frame(frame) {
      if (frame.t === "inbox") latest = frame.inbox;
      model.receive(frame);
    },
  }, {
    socket: (address) =>
      socket = Reflect.construct(WebSocket, [address, {
        headers: { Origin: url },
      }]) as WebSocket,
  });
  const model = createInbox(connection.rpc);
  await connection.connect();
  await waitFor(() => latest, Boolean);
  return {
    connection,
    model,
    inbox: () => latest!,
    async stop() {
      const closed = new Promise<void>((resolve) =>
        socket!.addEventListener("close", () => resolve(), { once: true })
      );
      connection.stop();
      await closed;
    },
  };
}

// This test exercises multiple project creation intents. Its backend must honor
// the directory (the shared core-only fixture deliberately returns one session).
function projectCreation(app: Awaited<ReturnType<typeof coreBackendFixture>>) {
  app.app.backend.core.createSession = (input) =>
    Promise.resolve({
      ...app.session,
      id: crypto.randomUUID(),
      directory: input.directory,
    });
}

test("inbox RPCs broadcast persisted projects, task ordering, seen and same-batch finishes to two framework-free consumers and survive restart", async () => {
  const root = await fixture();
  let app = await coreBackendFixture(root);
  projectCreation(app);
  let a = await consumer(app.url), b = await consumer(app.url);
  try {
    const rpc = a.connection.rpc;
    assertEquals(
      a.inbox().projects.map((p) => [p.directory, p.added, p.order]),
      [],
    );
    await a.model.openSession("core", root);
    assertEquals((await rpc.call("projects.list", {})).length, 0);
    await a.model.act(root, () => Promise.resolve());
    await waitFor(() => a.inbox().projects.length === 1, Boolean);
    assertEquals(await rpc.call("sessions.finishes", {}), {});
    const empty = join(root, "empty");
    await Deno.mkdir(empty);
    await rpc.call("projects.add", { directory: empty });
    await waitFor(() => b.inbox().projects.length === 2, Boolean);
    assertEquals(
      (await rpc.call("projects.list", {})).map((p) => p.directory),
      [root, empty],
    );
    const first = await rpc.call("tasks.create", {
      directory: root,
      name: "plan",
    });
    const second = await rpc.call("tasks.create", {
      directory: root,
      name: "exec",
    });
    await rpc.call("tasks.rename", { id: first.id, name: "research" });
    await rpc.call("tasks.sessions", { id: first.id, sessions: ["core"] });
    await assertRejects(() =>
      rpc.call("tasks.sessions", { id: second.id, sessions: ["core"] })
    );
    await rpc.call("tasks.reorder", {
      directory: root,
      ids: [second.id, first.id],
    });
    await waitFor(
      () =>
        b.inbox().tasks[0]?.id === second.id &&
        b.inbox().tasks[1]?.sessions[0] === "core",
      Boolean,
    );
    await rpc.call("projects.inactive", { directory: root, inactive: true });
    await waitFor(() => b.inbox().projects[0].inactive, Boolean);
    const entry = app.app.index.get("core")!;
    app.app.index.upsert({ ...entry, status: "busy" });
    app.app.index.upsert({ ...entry, status: "idle" });
    await waitFor(
      () => b.inbox().finishes.core && !b.inbox().projects[0].inactive,
      Boolean,
    );
    const finish = b.inbox().finishes.core;
    assert(finish > 0);
    const projected = inboxProjects([entry], b.model.state.inbox, Date.now());
    assertEquals([projected[0].status, projected[0].unread], [
      "finished",
      true,
    ]);
    await a.model.openSession("core", root);
    await waitFor(() => (b.inbox().seen.core ?? 0) >= finish, Boolean);
    assertEquals(
      inboxProjects([entry], b.model.state.inbox, Date.now())[0].unread,
      false,
    );
    for (const action of ["send", "approve", "answer", "interrupt"]) {
      const before = b.inbox().projects[0].lastVisit;
      await new Promise((resolve) => setTimeout(resolve, 2));
      assertEquals(
        await a.model.act(root, () => Promise.resolve(action)),
        action,
      );
      await waitFor(() => b.inbox().projects[0].lastVisit > before, Boolean);
    }
    await rpc.call("projects.inactive", { directory: root, inactive: true });
    app.app.index.upsert({
      ...entry,
      attention: { ...entry.attention, questions: 1 },
    });
    await waitFor(() => !b.inbox().projects[0].inactive, Boolean);
    app.app.index.upsert(entry);
    assertEquals((await rpc.call("sessions.finishes", {})).core, finish);
    await rpc.call("tasks.close", { id: first.id });
    await waitFor(() => b.inbox().tasks.length === 1, Boolean);
    assert(app.app.index.get("core"));
    const promoted = await a.model.promote(entry);
    await waitFor(
      () => b.inbox().tasks.some((t) => t.id === promoted.id),
      Boolean,
    );
    assertEquals(promoted.sessions, ["core"]);
    assertEquals(promoted.name, entry.title);
    assertEquals(
      (await rpc.call("tasks.list", { directory: root })).map((t) => t.id),
      [second.id, promoted.id],
    );
    await rpc.call("tasks.close", { id: promoted.id });
    await rpc.call("projects.templates", {
      templates: [join(root, "{project}")],
    });
    await waitFor(() => b.inbox().pathTemplates.length === 1, Boolean);
    await a.stop();
    await b.stop();
    await app.app.stop();
    app = await coreBackendFixture(root);
    a = await consumer(app.url);
    b = await consumer(app.url);
    assertEquals(a.inbox(), b.inbox());
    assertEquals(a.inbox().finishes.core, finish);
    assert(a.inbox().seen.core >= finish);
    assertEquals(a.inbox().tasks.map((t) => t.id), [second.id]);
    assertEquals(a.inbox().projects.map((p) => [p.directory, p.order]), [[
      root,
      0,
    ], [empty, 1]]);
    assertEquals(a.inbox().pathTemplates, [join(root, "{project}")]);
    await waitFor(
      async () =>
        JSON.stringify(await a.connection.rpc.call("inbox.get", {})) ===
          JSON.stringify(a.inbox()),
      Boolean,
    );
  } finally {
    await a.stop();
    await b.stop();
    await app.app.stop();
  }
});

test("server path-template scanning reads only matching directories, supports suffixes and rejects unbounded wildcard syntax", async () => {
  const root = await fixture(), projects = join(root, "projects");
  await Deno.mkdir(join(projects, "one", "repo"), { recursive: true });
  await Deno.mkdir(join(projects, "two"));
  await Deno.mkdir(join(root, "unrelated"));
  await Deno.writeTextFile(join(projects, "file"), "not a directory");
  const app = await coreBackendFixture(root), client = await consumer(app.url);
  try {
    const rpc = client.connection.rpc;
    await rpc.call("projects.templates", {
      templates: [
        join(projects, "{project}", "repo"),
        join(root, "absent", "{project}"),
      ],
    });
    assertEquals(await rpc.call("projects.scan", {}), [
      join(projects, "one", "repo"),
    ]);
    await rpc.call("projects.templates", {
      templates: [join(projects, "{project}")],
    });
    assertEquals(await rpc.call("projects.scan", {}), [
      join(projects, "one"),
      join(projects, "two"),
    ]);
    await assertRejects(() =>
      rpc.call("projects.templates", { templates: [join(root, "**")] })
    );
    await assertRejects(() =>
      rpc.call("projects.templates", {
        templates: [join(root, "{project}", "{project}")],
      })
    );
    assertEquals((await rpc.call("inbox.get", {})).pathTemplates, [
      join(projects, "{project}"),
    ]);
    await assertRejects(() =>
      rpc.call("projects.add", { directory: join(projects, "file") })
    );
    await assertRejects(() =>
      rpc.call("projects.inactive", {
        directory: root,
        inactive: "yes" as never,
      })
    );
  } finally {
    await client.stop();
    await app.app.stop();
  }
});

test("first-run setup and restart retain the same user's inbox metadata", async () => {
  const root = await fixture(), seeded = await coreBackendFixture(root);
  const backend = seeded.app.backend;
  await seeded.app.stop();
  const settings = cfg();
  settings.auth.type = "";
  settings.auth.username = "";
  settings.server.port = 0;
  settings.state.path = join(root, "fresh-state");
  let app = await startApplication(settings, backend, root);
  const clients: WsClient[] = [];
  try {
    const url = `http://127.0.0.1:${app.server.addr.port}`;
    const setup = await fetch(url + "/api/setup", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "password",
        username: "Alice",
        password: "test-password",
      }),
    });
    assertEquals(setup.status, 200);
    await setup.json();
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Alice", password: "test-password" }),
    });
    assertEquals(login.status, 200);
    await login.json();
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const first = new WsClient(url, cookie);
    clients.push(first);
    await first.connect();
    projectCreation(seeded);
    const empty = join(root, "private");
    await Deno.mkdir(empty);
    await first.rpc("projects.add", { directory: empty });
    const seen = await first.rpc<number>("sessions.seen", {
      sessionID: "core",
    });
    await first.close();
    await app.stop();
    app = await startApplication(settings, backend, root);
    const second = new WsClient(
      `http://127.0.0.1:${app.server.addr.port}`,
      cookie,
    );
    clients.push(second);
    await second.connect();
    const inbox = await second.rpc<InboxSnapshot>("inbox.get", {});
    assert(inbox.projects.some((p) => p.directory === empty && p.added));
    assertEquals(inbox.seen.core, seen);
  } finally {
    for (const client of clients) await client.close();
    await app.stop();
  }
});
