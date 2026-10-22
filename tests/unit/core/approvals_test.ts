// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../support/resources.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { OtkDb, permissionMigrations, PermissionStore } from "@otk/store";
import type { Harness } from "@otk/harness";
import {
  belongsToSession,
  type IndexEntry,
  type PermissionRequest,
  type PermissionsCapability,
} from "@otk/protocol";
import { PermissionFeature } from "../../../core/features/approvals.ts";
import { IndexStore, RpcRegistry } from "../../../core/mod.ts";
import { register as registerPermissions } from "../../../core/features/permissions.ts";
import { fixture } from "../../support/config.ts";
import { waitFor } from "../../support/opencode.ts";
const backend = (permissions: PermissionsCapability): Harness => ({
  core: {
    kind: "test",
    version: "1",
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    subscriptions() {},
    getSession: (id) =>
      ["root", "child", "other", "cycle-a", "cycle-b"].includes(id)
        ? Promise.resolve({
          id,
          directory: "/owned",
          projectID: "p",
          title: id,
          archived: false,
          time: { created: 1, updated: 1 },
        })
        : Promise.reject(new Error("Unknown session")),
    listChildren: () => Promise.resolve([]),
    listMessages: () => Promise.resolve([]),
    createSession: () =>
      Promise.reject(new Error("Not part of the approval fixture")),
  },
  capabilities: { permissions },
});

const entry = (id: string, parentID?: string): IndexEntry => ({
  id,
  parentID,
  directory: "/owned",
  projectID: "p",
  title: id,
  timeCreated: 1,
  timeUpdated: 1,
  archived: false,
  status: "busy",
  attention: {
    permissions: parentID ? 1 : 0,
    childPermissions: parentID ? 0 : 1,
    questions: 0,
    childQuestions: 0,
  },
});
const request = (id: string, sessionID = "child"): PermissionRequest => ({
  id,
  sessionID,
  kind: "bash",
  title: "bash",
  patterns: ["printf exact"],
  alwaysPatterns: ["printf *"],
  time: 1,
  detail: { kind: "bash", command: "printf exact" },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("server-owned auto-approve can be turned off and its activity read while the backend is offline", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations]),
    store = new PermissionStore(db),
    index = new IndexStore();
  const capability = {
    listPermissions: () => Promise.resolve([]),
    replyPermission: () => Promise.resolve(),
  };
  const feature = new PermissionFeature(store, index, capability),
    unavailable = backend(capability);
  let lookups = 0;
  unavailable.core.getSession = () => {
    lookups++;
    return Promise.reject(new Error("Backend offline"));
  };
  const rpc = new RpcRegistry(unavailable, db);
  feature.register(rpc);
  try {
    index.reset([entry("root"), entry("child", "root")]);
    store.setAuto("root", true);
    const item = request("recorded");
    store.finish(
      store.start({
        session: item.sessionID,
        requestID: item.id,
        request: JSON.stringify(item),
        reply: "once",
        source: "auto",
        owner: "root",
      }, ["root"]),
      { outcome: "confirmed" },
    );
    const results = await Promise.allSettled([
      rpc.dispatch("permission.auto", { sessionID: "root", enabled: false }),
      rpc.dispatch("permission.activity", { sessionID: "root" }),
    ]);
    assertEquals(results.map((result) => result.status), [
      "fulfilled",
      "fulfilled",
    ]);
    assertEquals(
      lookups,
      0,
      "OTK-owned policy-off and stored activity cannot depend on a native session lookup",
    );
    assertEquals(store.enabled(), []);
    assert(results[1].status === "fulfilled");
    assertEquals(
      (results[1].value as { entries: unknown[] }).entries.length,
      1,
    );
  } finally {
    feature.close();
    db.close();
  }
});

test("server session auto-approve rechecks off after held lists, isolates ancestry and serializes automatic/manual replies without browser subscriptions", async () => {
  const root = await fixture(),
    db = new OtkDb(root, [permissionMigrations]),
    store = new PermissionStore(db),
    index = new IndexStore();
  let closed = false;
  const held = deferred<PermissionRequest[]>(), ack = deferred<void>();
  let hold = true;
  const replies: unknown[] = [];
  const requests = [
    request("one"),
    request("outside", "other"),
    request("cycle", "cycle-a"),
  ];
  const capability = {
    listPermissions: () => hold ? held.promise : Promise.resolve(requests),
    replyPermission: (input: unknown) => {
      replies.push(input);
      return ack.promise;
    },
  };
  const feature = new PermissionFeature(store, index, capability),
    harness = backend(capability),
    rpc = new RpcRegistry(harness, db);
  feature.register(rpc);
  registerPermissions(rpc, harness, (input) => feature.reply(input));
  try {
    index.reset([
      entry("root"),
      entry("child", "root"),
      entry("other"),
      entry("cycle-a", "cycle-b"),
      entry("cycle-b", "cycle-a"),
    ]);
    assertEquals(store.enabled(), []);
    assertEquals(feature.owner("child"), undefined);
    await assertRejects(() =>
      rpc.dispatch("permission.auto", { sessionID: "root", enabled: "true" })
    );
    await assertRejects(
      () =>
        rpc.dispatch("permission.auto", {
          sessionID: "missing",
          enabled: true,
        }),
      Error,
      "Unknown session",
    );
    assertEquals(store.enabled(), []);
    await rpc.dispatch("permission.auto", { sessionID: "root", enabled: true });
    await rpc.dispatch("permission.auto", {
      sessionID: "root",
      enabled: false,
    });
    held.resolve(requests);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(replies, [], "Off wins over a previously started list");
    assertEquals(store.list(["root", "child"]), []);
    hold = false;
    await rpc.dispatch("permission.auto", { sessionID: "root", enabled: true });
    await waitFor(() => store.list(["child"]), (rows) => rows.length === 1);
    assertEquals(store.list(["child"])[0].outcome, "started");
    index.upsert(entry("child", "root"));
    await assertRejects(
      () =>
        rpc.dispatch("permission.reply", {
          sessionID: "child",
          requestID: "one",
          reply: "reject",
          message: "conflicting action",
        }),
      Error,
      "already being answered",
    );
    ack.resolve();
    await waitFor(
      () => store.list(["child"])[0].outcome,
      (outcome) => outcome === "confirmed",
    );
    index.upsert(entry("root"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(replies, [{
      sessionID: "child",
      requestID: "one",
      reply: "once",
    }]);
    assertEquals(feature.owner("other"), undefined);
    assertEquals(feature.owner("cycle-a"), undefined);
    const rows = store.list(["child"]);
    assertEquals([rows[0].source, rows[0].owner], ["auto", "root"]);
    feature.close();
    db.close();
    closed = true;
    const reopened = new OtkDb(root, [permissionMigrations]);
    try {
      const persisted = new PermissionStore(reopened);
      assertEquals(persisted.enabled(), ["root"]);
      assert(persisted.confirmed("child", "one"));
      assertEquals(persisted.list(["child"])[0].outcome, "confirmed");
      const restoredIndex = new IndexStore();
      const restoredFeature = new PermissionFeature(
        persisted,
        restoredIndex,
        capability,
      );
      try {
        restoredIndex.reset([
          entry("root"),
          entry("child", "root"),
          entry("other"),
          entry("cycle-a", "cycle-b"),
          entry("cycle-b", "cycle-a"),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assertEquals(
          replies.length,
          1,
          "A confirmed request cannot be sent again after reopening otk.db",
        );
        requests.push(request("late-child"));
        restoredIndex.reset([entry("child", "root"), entry("other")]);
        await waitFor(
          () => persisted.confirmed("child", "late-child"),
          (confirmed) => confirmed,
        );
        assertEquals(
          replies.length,
          2,
          "A known helper inherits even when its policy owner is outside the live index window",
        );
        assertEquals(
          persisted.list(["root"]).length,
          2,
          "Historical family membership is persisted, not reconstructed from the current index",
        );
      } finally {
        restoredFeature.close();
      }
    } finally {
      reopened.close();
    }
  } finally {
    feature.close();
    if (!closed) db.close();
  }
});

test("automatic Allow once is kind-agnostic for bash, edit and optional-metadata generic permissions", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations]),
    store = new PermissionStore(db),
    index = new IndexStore();
  const pending: PermissionRequest[] = [request("bash"), {
    ...request("edit"),
    kind: "edit",
    detail: {
      kind: "edit",
      files: [{
        path: "/project/file.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [],
      }],
    },
  }, {
    ...request("web"),
    kind: "websearch",
    patterns: ["exact query"],
    detail: { kind: "generic", summary: "exact query" },
  }];
  const replies: unknown[] = [];
  const feature = new PermissionFeature(store, index, {
    listPermissions: () => Promise.resolve(pending),
    replyPermission: (input) => {
      replies.push(input);
      return Promise.resolve();
    },
  });
  try {
    store.setAuto("root", true);
    index.reset([entry("root"), entry("child", "root")]);
    await waitFor(
      () =>
        store.list(["root"]).filter((row) => row.outcome === "confirmed")
          .length,
      (count) => count === 3,
    );
    assertEquals(
      replies,
      pending.map((item) => ({
        sessionID: item.sessionID,
        requestID: item.id,
        reply: "once",
      })),
    );
  } finally {
    feature.close();
    db.close();
  }
});

test("permission activity journals manual outcomes, errors and shutdown uncertainty, and pages complete family metadata", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations]),
    store = new PermissionStore(db, () => 123),
    index = new IndexStore();
  let pending = request("manual", "root");
  let fail = false;
  let failure: unknown = new Error("native failure");
  let hold: ReturnType<typeof deferred<void>> | undefined;
  const capability = {
    listPermissions: () => Promise.resolve([pending]),
    replyPermission: () =>
      fail ? Promise.reject(failure) : hold?.promise ?? Promise.resolve(),
  };
  const feature = new PermissionFeature(store, index, capability),
    rpc = new RpcRegistry(backend(capability), db);
  feature.register(rpc);
  try {
    index.reset([entry("root"), entry("child", "root"), entry("other")]);
    await feature.reply({
      sessionID: "root",
      requestID: pending.id,
      reply: "reject",
      message: "Keep exact feedback",
    });
    assertEquals(store.list(["root"])[0].message, "Keep exact feedback");
    assertEquals(store.list(["root"])[0].source, "manual");
    await assertRejects(
      () =>
        feature.reply({
          sessionID: "child",
          requestID: pending.id,
          reply: "once",
        }),
      Error,
      "no longer pending",
    );
    pending = request("failed", "root");
    fail = true;
    await assertRejects(
      () =>
        feature.reply({
          sessionID: "root",
          requestID: pending.id,
          reply: "once",
        }),
      Error,
      "native failure",
    );
    assertEquals([
      store.list(["root"])[0].outcome,
      store.list(["root"])[0].error,
    ], ["failed", "native failure"]);
    for (
      const [id, rejection] of [["string-failure", "plain rejection"], [
        "undefined-failure",
        undefined,
      ]] as const
    ) {
      pending = request(id, "root");
      failure = rejection;
      await feature.reply({
        sessionID: "root",
        requestID: pending.id,
        reply: "once",
      }).then(
        () => assert(false, "The reply must reject"),
        (error) => assertEquals(error, rejection),
      );
      assertEquals(
        store.list(["root"])[0].outcome,
        "failed",
        "A non-Error rejection must never be recorded as a confirmed reply",
      );
      assertEquals(store.confirmed("root", pending.id), false);
    }
    fail = false;
    for (let n = 0; n < 105; n++) {
      const req = request(`history-${n}`, n % 2 ? "child" : "root");
      const id = store.start({
        session: req.sessionID,
        requestID: req.id,
        request: JSON.stringify(req),
        reply: "once",
        source: "auto",
        owner: "root",
      }, req.sessionID === "child" ? ["root"] : []);
      store.finish(id, { outcome: "confirmed" });
    }
    index.reset([entry("root"), entry("other")]);
    const first = await rpc.dispatch("permission.activity", {
      sessionID: "root",
    }) as { entries: { id: number }[]; before: number };
    assertEquals(first.entries.length, 100);
    const next = await rpc.dispatch("permission.activity", {
      sessionID: "root",
      before: first.before,
    }) as { entries: { id: number }[]; before?: number };
    assertEquals(next.entries.length, 9);
    assertEquals(next.before, undefined);
    assertEquals(
      new Set([...first.entries, ...next.entries].map((row) => row.id)).size,
      109,
    );
    pending = request("uncertain", "root");
    hold = deferred<void>();
    const reply = feature.reply({
      sessionID: "root",
      requestID: pending.id,
      reply: "once",
    });
    await waitFor(
      () => store.list(["root"])[0].requestID,
      (id) => id === "uncertain",
    );
    feature.close();
    hold.resolve();
    await reply;
    assertEquals(
      store.list(["root"])[0].outcome,
      "started",
      "Shutdown cannot claim an unobserved acknowledgement succeeded",
    );
    assert(
      !belongsToSession("child", "root", (id) => index.get(id)),
      "The helper is absent from the live family while its historical activity remains complete",
    );
  } finally {
    feature.close();
    db.close();
  }
});
