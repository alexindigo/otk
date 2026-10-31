// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  Frecency,
  frecencyMigrations,
  OtkDb,
  permissionMigrations,
  PermissionStore,
  Prefs,
  prefsMigrations,
  Projects,
  projectsMigrations,
  ProjectTemplates,
  projectTemplatesMigrations,
  Requests,
  requestsMigrations,
  Seen,
  seenMigrations,
  type StoreWrite,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { test } from "../../../tests/support/resources.ts";
import { fixture, frecencyOptions, prefsOptions } from "./support.ts";

test("explicit write scopes reject foreign, expired, async and accidental nested work", async () => {
  const db = new OtkDb(await fixture(), [tasksMigrations], { busyms: 5000 });
  const other = new OtkDb(await fixture(), [tasksMigrations], { busyms: 5000 });
  try {
    let expired!: StoreWrite;
    db.write((tx) => {
      expired = tx;
      assertThrows(() => other.write(() => {}, tx));
      assertThrows(() => db.transaction(() => {}));
      assertThrows(() => db.write(() => {}));
      new Tasks(db).create("/p", "kept", [], tx);
    });
    assertThrows(() => db.write(() => {}, expired));
    assertThrows(() => db.afterCommit(expired, () => {}));
    assertThrows(() =>
      db.afterCommit(undefined as unknown as StoreWrite, () => {})
    );
    assertThrows(() => db.write(() => Promise.resolve("async")));
    assertEquals(new Tasks(db).list().map((t) => t.name), ["kept"]);
  } finally {
    db.close();
    other.close();
  }
});

test("every local metadata writer joins one rollback and publishes only detached committed snapshots", async () => {
  const failures: unknown[] = [];
  const db = new OtkDb(await fixture(), [
    tasksMigrations,
    projectsMigrations,
    prefsMigrations,
    seenMigrations,
    frecencyMigrations,
    projectTemplatesMigrations,
    permissionMigrations,
    requestsMigrations,
  ], { busyms: 5000, observerError: (e) => failures.push(e) });
  try {
    const tasks = new Tasks(db), projects = new Projects(db, () => 8);
    const prefs = new Prefs(db, prefsOptions), seen = new Seen(db, () => 9);
    const files = new Frecency(db, frecencyOptions),
      templates = new ProjectTemplates(db);
    const permissions = new PermissionStore(db, () => 10);
    const requests = new Requests(db);
    const intent = {
      principal: "u",
      client_id: "tab",
      intent_key: "all-local-writes",
      window_id: requests.window(0, 100).id,
      method: "metadata.write",
      fingerprint: "d".repeat(64),
      execution: "local" as const,
      state: "queued" as const,
      seq: 1,
      accepted_at: 1,
      updated_at: 1,
      retention_until: 200,
      dispatched_at: null,
      owner_run: null,
      scope_session: null,
      scope_directory: "/p",
      scope_resource: null,
      progress_code: null,
      progress_completed: null,
      progress_total: null,
      receipt_kind: null,
      receipt_json: null,
      error_code: null,
      error_retry: null,
      error_field: null,
      diagnostic_id: null,
    };
    requests.admit(intent);
    const events: unknown[] = [];
    for (
      const owner of [tasks, projects, prefs, seen, templates, permissions]
    ) {
      owner.listen(() => {
        throw new Error("observer");
      });
      owner.listen((value) => events.push(value));
      owner.listen(() =>
        assertEquals(requests.get(intent)?.state, "succeeded")
      );
    }
    const mutate = (tx: StoreWrite) => {
      projects.discover("/p", tx);
      projects.add("u", "/p", tx);
      projects.visit("u", "/p", tx);
      projects.inactive("u", "/p", true, tx);
      projects.reactivate("u", "/p", tx);
      const task = tasks.create("/p", "created", [], tx);
      tasks.rename(task.id, "renamed", tx);
      tasks.sessions(task.id, ["s"], tx);
      tasks.addSession(task.id, "s2", tx);
      tasks.removeSession(task.id, "s", tx);
      tasks.reorder("/p", [task.id], tx);
      const discarded = tasks.create("/p", "discarded", [], tx);
      tasks.close(discarded.id, tx);
      const value = prefs.set("thinking", "show", tx);
      value.thinking = "hide";
      seen.mark("u", "s", tx);
      files.bump("/p", "f", tx);
      templates.set(["/root/{project}"], tx);
      permissions.setAuto("s", true, tx);
      const id = permissions.start(
        {
          session: "s",
          requestID: "r",
          request: "{}",
          reply: "once",
          source: "manual",
        },
        ["parent"],
        tx,
      );
      permissions.finish(id, { outcome: "confirmed" }, tx);
      requests.transition(intent, 1, {
        state: "succeeded",
        receipt_kind: "metadata",
        receipt_json: '{"saved":true}',
      }, tx);
      assertEquals(events.length, 0);
    };
    assertThrows(() =>
      db.write((tx) => {
        mutate(tx);
        throw new Error("rollback");
      })
    );
    assertEquals(tasks.list(), []);
    assertEquals(projects.list("u"), []);
    assertEquals(seen.list("u"), {});
    assertEquals(files.list("/p"), []);
    assertEquals(templates.list(), ["~/Projects/{project}"]);
    assertEquals(permissions.enabled(), []);
    assertEquals(permissions.list(["s"], undefined, 101), []);
    assertEquals(prefs.get().thinking, "hide");
    assertEquals(events, []);
    assertEquals(requests.get(intent)?.state, "queued");
    db.write(mutate);
    assertEquals(tasks.list()[0].sessions, ["s2"]);
    assertEquals(files.list("/p")[0].score, 1);
    assertEquals(seen.time("u", "s"), 9);
    assertEquals(
      permissions.list(["parent"], undefined, 101)[0].outcome,
      "confirmed",
    );
    assertEquals(prefs.get().thinking, "show");
    assertEquals(requests.get(intent)?.state, "succeeded");
    assertEquals<unknown[]>(
      events.filter((e) =>
        typeof e === "object" && e !== null && "thinking" in e
      ),
      [{ thinking: "show", timestamps: false }],
    );
    assertEquals(events.length, failures.length);
  } finally {
    db.close();
  }
});
