// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTaskActions } from "@otk/client";
import type { TaskRecord } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";

for (const change of ["add", "remove"]) {
  test(`captured task actions preserve concurrent ${change} from another connection`, async () => {
    const root = await fixture(), f = await inboxBrowserFixture(root);
    const a = new WsClient(f.url), b = new WsClient(f.url);
    try {
      await a.connect();
      await b.connect();
      const base = f.entries[0];
      for (const id of ["second", "third"]) f.add({ ...base, id, title: id });
      const task = await a.rpc<TaskRecord>("tasks.create", {
        directory: base.directory,
        name: "Shared task",
        sessions: [base.id],
      });
      const actions = (client: WsClient) =>
        createTaskActions({
          call: (method, params) => client.rpc(method, params),
        }, base.directory);
      if (change === "add") {
        await Promise.all([
          actions(a).add(task, "second"),
          actions(b).add(task, "third"),
        ]);
      } else {
        await b.rpc("tasks.sessions", { id: task.id, sessions: [] });
        await actions(a).add(task, "second");
      }
      const expected = change === "add"
        ? [base.id, "second", "third"]
        : ["second"];
      const saved = (await a.rpc<TaskRecord[]>("tasks.list", {}))[0];
      assertEquals(
        saved.sessions.slice().sort(),
        expected.slice().sort(),
        "Captured task membership overwrote another connection's intent",
      );
      for (const client of [a, b]) {
        const frame = await client.wait((frame) =>
          frame.t === "inbox" &&
          frame.inbox.tasks.some((t) =>
            t.id === task.id &&
            t.sessions.length === expected.length && expected.every((id) =>
              t.sessions.includes(id)
            )
          )
        );
        assertEquals(frame.t, "inbox");
      }
    } finally {
      await a.close();
      await b.close();
      await f.app.stop();
    }
  });
}

test("task member operations are idempotent, ordered, exclusive, validated and durable", async () => {
  const root = await fixture();
  let f = await inboxBrowserFixture(root), c = new WsClient(f.url);
  try {
    await c.connect();
    const base = f.entries[0];
    for (const id of ["second", "third", "fourth"]) {
      f.add({ ...base, id, title: id });
    }
    const task = await c.rpc<TaskRecord>("tasks.create", {
      directory: base.directory,
      name: "Shared task",
      sessions: [base.id],
    });
    const other = await c.rpc<TaskRecord>("tasks.create", {
      directory: base.directory,
      name: "Other task",
      sessions: ["third"],
    });
    const add = (sessionID: string, id = task.id) =>
      c.rpc<TaskRecord>("tasks.addSession", { id, sessionID });
    const remove = (sessionID: string, id = task.id) =>
      c.rpc<TaskRecord>("tasks.removeSession", { id, sessionID });
    await Promise.all([add("second"), add("second")]);
    assertEquals((await add(base.id)).sessions, [base.id, "second"]);
    await assertRejects(() => add("third"));
    await assertRejects(() => add("atmosphera"), Error, "another project");
    assertEquals((await remove("third")).sessions, [base.id, "second"]);
    assertEquals((await remove("third", other.id)).sessions, []);
    assertEquals((await add("third")).sessions, [base.id, "second", "third"]);
    await Promise.all([remove(base.id), remove(base.id), add("fourth")]);
    assertEquals((await add(base.id)).sessions, [
      "second",
      "third",
      "fourth",
      base.id,
    ]);
    // Delayed removals cannot ungroup a member that has since moved elsewhere.
    await remove("third");
    await add("third", other.id);
    await remove("third");
    for (const method of ["tasks.addSession", "tasks.removeSession"]) {
      for (const sessionID of [undefined, "", [], 3]) {
        await assertRejects(() => c.rpc(method, { id: task.id, sessionID }));
      }
      await assertRejects(() =>
        c.rpc(method, { id: "unknown", sessionID: base.id })
      );
    }
    const saved = await c.rpc<TaskRecord[]>("tasks.list", {});
    assertEquals(saved.find((t) => t.id === task.id)!.sessions, [
      "second",
      "fourth",
      base.id,
    ]);
    assertEquals(saved.find((t) => t.id === other.id)!.sessions, ["third"]);
    await c.close();
    await f.app.stop();
    f = await inboxBrowserFixture(root);
    c = new WsClient(f.url);
    await c.connect();
    assertEquals(await c.rpc("tasks.list", {}), saved);
  } finally {
    await c.close();
    await f.app.stop();
  }
});

test("task membership validation cannot publish into a task closed while awaiting the backend", async () => {
  const root = await fixture(), f = await inboxBrowserFixture(root);
  const a = new WsClient(f.url), b = new WsClient(f.url);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const get = f.app.backend.core.getSession;
  f.app.backend.core.getSession = async (id) => {
    if (id === "late") {
      entered.resolve();
      await release.promise;
      return { ...await get("otk"), id };
    }
    return await get(id);
  };
  try {
    await a.connect();
    await b.connect();
    const task = await a.rpc<TaskRecord>("tasks.create", {
      directory: f.entries[0].directory,
      name: "Closing task",
    });
    const pending = assertRejects(() =>
      a.rpc("tasks.addSession", { id: task.id, sessionID: "late" })
    );
    await entered.promise;
    await b.rpc("tasks.close", { id: task.id });
    release.resolve();
    await pending;
    const next = await b.rpc<TaskRecord>("tasks.create", {
      directory: f.entries[0].directory,
      name: "Next task",
      sessions: ["late"],
    });
    assertEquals(
      await a.rpc<TaskRecord[]>("tasks.list", {}),
      [next],
      "Closed task left orphan membership behind",
    );
  } finally {
    release.resolve();
    await a.close();
    await b.close();
    await f.app.stop();
  }
});
