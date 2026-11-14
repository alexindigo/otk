// SPDX-License-Identifier: LGPL-3.0-only
import { fixturePage } from "../../support/message-pages.ts";
import { test } from "../../support/resources.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  OtkDb,
  permissionMigrations,
  PermissionStore,
  Requests,
  requestsMigrations,
} from "@otk/store";
import type { Harness } from "@otk/harness";
import {
  belongsToSession,
  type IndexEntry,
  type PermissionRequest,
  type PermissionsCapability,
  type RequestEvent,
} from "@otk/protocol";
import { PermissionFeature } from "../../../core/features/approvals.ts";
import {
  IndexStore,
  RequestCoordinator,
  RpcRegistry,
} from "../../../core/mod.ts";
import { register as registerPermissions } from "../../../core/features/permissions.ts";
import { fixture } from "../../support/config.ts";
import { waitFor } from "../../support/opencode.ts";
import { cfg } from "./support.ts";
const backend = (permissions: PermissionsCapability): Harness => ({
  core: {
    kind: "test",
    version: "1",
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    subscriptions() {},
    identities: (ids) =>
      Promise.resolve(
        ids.filter((id) =>
          [
            "tstv1-root",
            "tstv1-child",
            "tstv1-other",
            "tstv1-cycle-a",
            "tstv1-cycle-b",
          ].includes(id)
        ).map((id) => ({ id, directory: "/owned" })),
      ),
    getSession: (id) =>
      [
          "tstv1-root",
          "tstv1-child",
          "tstv1-other",
          "tstv1-cycle-a",
          "tstv1-cycle-b",
        ].includes(id)
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
    listSessions: () =>
      Promise.resolve({ items: [], older: null, generation: "fixture" }),
    listMessages: (id) => Promise.resolve(fixturePage(id)),
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
  digest: { state: "digesting", revision: 0, turns: {} },
  attention: {
    permissions: parentID ? 1 : 0,
    childPermissions: parentID ? 0 : 1,
    questions: 0,
    childQuestions: 0,
  },
});
const request = (id: string, sessionID = "tstv1-child"): PermissionRequest => ({
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

test("permission owner returns terminal rejection for replies it did not dispatch", async () => {
  const db = new OtkDb(await fixture(), [
    permissionMigrations,
    requestsMigrations,
  ], { busyms: 5000 });
  const store = new PermissionStore(db), index = new IndexStore();
  let pending: PermissionRequest[] = [], calls = 0;
  const ack = deferred<void>();
  const capability: PermissionsCapability = {
    listPermissions: () => Promise.resolve(pending),
    replyPermission: () => {
      calls++;
      return ack.promise;
    },
  };
  const feature = new PermissionFeature(store, index, capability);
  const harness = backend(capability), rpc = new RpcRegistry(harness, db);
  registerPermissions(
    rpc,
    harness,
    (input, operation) => feature.reply(input, operation),
  );
  const coordinator = new RequestCoordinator({
    registry: rpc,
    receipts: new Requests(db),
    policy: cfg().requests,
  });
  await coordinator.start();
  const issue = async (requestID: string, principal = "local") => {
    const events: RequestEvent[] = [];
    await coordinator.accept(principal, {
      t: "request",
      ref: {
        id: crypto.randomUUID(),
        clientID: crypto.randomUUID(),
        key: crypto.randomUUID(),
        window: coordinator.window().id,
      },
      method: "permission.reply",
      params: { sessionID: "tstv1-child", requestID, reply: "once" },
    }, {
      send: (event) => events.push(event),
      lease: {
        id: crypto.randomUUID(),
        signal: new AbortController().signal,
        defer() {},
      },
    });
    return events;
  };
  const rejected = (events: RequestEvent[]) => {
    const result = events.at(-1);
    assert(result?.t === "request.result", JSON.stringify(events));
    assert(!result.outcome.ok);
    assertEquals(result.outcome.error.code, "permission");
  };
  try {
    const absent = await issue("not-observed");
    await coordinator.idle();
    rejected(absent);
    assertEquals(calls, 0);
    assertEquals(store.list(["tstv1-child"], undefined, 101), []);

    pending = [request("one")];
    const first = await issue("one");
    await waitFor(() => calls, (count) => count === 1);
    // A different principal has an independent coordinator ordering lane, but
    // the permission owner's request reservation still prevents a second reply.
    const duplicate = await issue("one", "another");
    await waitFor(
      () => duplicate.at(-1)?.t,
      (type) => type === "request.result",
    );
    rejected(duplicate);
    ack.resolve();
    await coordinator.idle();
    const completed = first.at(-1);
    assert(completed?.t === "request.result" && completed.outcome.ok);

    const confirmed = await issue("one");
    await coordinator.idle();
    rejected(confirmed);
    assertEquals(calls, 1, "duplicate replies never reach the native backend");

    pending = [request("uncertain")];
    store.start({
      session: "tstv1-child",
      requestID: "uncertain",
      request: JSON.stringify(pending[0]),
      reply: "once",
      source: "manual",
    }, []);
    const uncertain = await issue("uncertain");
    await coordinator.idle();
    const reconciling = uncertain.at(-1);
    assert(reconciling?.t === "request.progress");
    assertEquals(reconciling.progress.phase, "reconciling");
    assertEquals(calls, 1, "an unconfirmed prior dispatch is never retried");

    feature.close();
    const stopped = await issue("uncertain");
    await coordinator.idle();
    rejected(stopped);
    assertEquals(calls, 1);
  } finally {
    ack.resolve();
    feature.close();
    await coordinator.stop();
    db.close();
  }
});

test("server-owned auto-approve can be turned off and its activity read while the backend is offline", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations], {
      busyms: 5000,
    }),
    store = new PermissionStore(db),
    index = new IndexStore();
  const capability = {
    listPermissions: () => Promise.resolve([]),
    replyPermission: () => Promise.resolve(),
  };
  const feature = new PermissionFeature(store, index, capability),
    unavailable = backend(capability);
  let lookups = 0;
  unavailable.core.identities = () => {
    lookups++;
    return Promise.reject(new Error("Backend offline"));
  };
  const rpc = new RpcRegistry(unavailable, db);
  feature.register(rpc);
  try {
    index.reset([entry("tstv1-root"), entry("tstv1-child", "tstv1-root")]);
    store.setAuto("tstv1-root", true);
    const item = request("recorded");
    store.finish(
      store.start({
        session: item.sessionID,
        requestID: item.id,
        request: JSON.stringify(item),
        reply: "once",
        source: "auto",
        owner: "tstv1-root",
      }, ["tstv1-root"]),
      { outcome: "confirmed" },
    );
    const results = await Promise.allSettled([
      rpc.dispatch("permission.auto", {
        sessionID: "tstv1-root",
        enabled: false,
      }),
      rpc.dispatch("permission.activity", { sessionID: "tstv1-root" }),
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
    db = new OtkDb(root, [permissionMigrations], { busyms: 5000 }),
    store = new PermissionStore(db),
    index = new IndexStore();
  let closed = false;
  const held = deferred<PermissionRequest[]>(), ack = deferred<void>();
  let hold = true;
  const replies: unknown[] = [];
  const requests = [
    request("one"),
    request("outside", "tstv1-other"),
    request("cycle", "tstv1-cycle-a"),
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
      entry("tstv1-root"),
      entry("tstv1-child", "tstv1-root"),
      entry("tstv1-other"),
      entry("tstv1-cycle-a", "tstv1-cycle-b"),
      entry("tstv1-cycle-b", "tstv1-cycle-a"),
    ]);
    assertEquals(store.enabled(), []);
    assertEquals(feature.owner("tstv1-child"), undefined);
    await assertRejects(() =>
      rpc.dispatch("permission.auto", {
        sessionID: "tstv1-root",
        enabled: "true",
      })
    );
    await assertRejects(
      () =>
        rpc.dispatch("permission.auto", {
          sessionID: "tstv1-missing",
          enabled: true,
        }),
      Error,
      "That session is no longer available.",
    );
    assertEquals(store.enabled(), []);
    await rpc.dispatch("permission.auto", {
      sessionID: "tstv1-root",
      enabled: true,
    });
    await rpc.dispatch("permission.auto", {
      sessionID: "tstv1-root",
      enabled: false,
    });
    held.resolve(requests);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(replies, [], "Off wins over a previously started list");
    assertEquals(store.list(["tstv1-root", "tstv1-child"], undefined, 101), []);
    hold = false;
    await rpc.dispatch("permission.auto", {
      sessionID: "tstv1-root",
      enabled: true,
    });
    await waitFor(
      () => store.list(["tstv1-child"], undefined, 101),
      (rows) => rows.length === 1,
    );
    assertEquals(
      store.list(["tstv1-child"], undefined, 101)[0].outcome,
      "started",
    );
    index.upsert(entry("tstv1-child", "tstv1-root"));
    await assertRejects(
      () =>
        rpc.dispatch("permission.reply", {
          sessionID: "tstv1-child",
          requestID: "one",
          reply: "reject",
          message: "conflicting action",
        }),
      Error,
      "already being answered",
    );
    ack.resolve();
    await waitFor(
      () => store.list(["tstv1-child"], undefined, 101)[0].outcome,
      (outcome) => outcome === "confirmed",
    );
    index.upsert(entry("tstv1-root"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(replies, [{
      sessionID: "tstv1-child",
      requestID: "one",
      reply: "once",
    }]);
    assertEquals(feature.owner("tstv1-other"), undefined);
    assertEquals(feature.owner("tstv1-cycle-a"), undefined);
    const rows = store.list(["tstv1-child"], undefined, 101);
    assertEquals([rows[0].source, rows[0].owner], ["auto", "tstv1-root"]);
    feature.close();
    db.close();
    closed = true;
    const reopened = new OtkDb(root, [permissionMigrations], { busyms: 5000 });
    try {
      const persisted = new PermissionStore(reopened);
      assertEquals(persisted.enabled(), ["tstv1-root"]);
      assert(persisted.confirmed("tstv1-child", "one"));
      assertEquals(
        persisted.list(["tstv1-child"], undefined, 101)[0].outcome,
        "confirmed",
      );
      const restoredIndex = new IndexStore();
      const restoredFeature = new PermissionFeature(
        persisted,
        restoredIndex,
        capability,
      );
      try {
        restoredIndex.reset([
          entry("tstv1-root"),
          entry("tstv1-child", "tstv1-root"),
          entry("tstv1-other"),
          entry("tstv1-cycle-a", "tstv1-cycle-b"),
          entry("tstv1-cycle-b", "tstv1-cycle-a"),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assertEquals(
          replies.length,
          1,
          "A confirmed request cannot be sent again after reopening otk.db",
        );
        requests.push(request("late-child"));
        restoredIndex.reset([
          entry("tstv1-child", "tstv1-root"),
          entry("tstv1-other"),
        ]);
        await waitFor(
          () => persisted.confirmed("tstv1-child", "late-child"),
          (confirmed) => confirmed,
        );
        assertEquals(
          replies.length,
          2,
          "A known helper inherits even when its policy owner is outside the live index window",
        );
        assertEquals(
          persisted.list(["tstv1-root"], undefined, 101).length,
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
  const db = new OtkDb(await fixture(), [permissionMigrations], {
      busyms: 5000,
    }),
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
    store.setAuto("tstv1-root", true);
    index.reset([entry("tstv1-root"), entry("tstv1-child", "tstv1-root")]);
    await waitFor(
      () =>
        store.list(["tstv1-root"], undefined, 101).filter((row) =>
          row.outcome === "confirmed"
        )
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
  const db = new OtkDb(await fixture(), [permissionMigrations], {
      busyms: 5000,
    }),
    store = new PermissionStore(db, () => 123),
    index = new IndexStore();
  let pending = request("manual", "tstv1-root");
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
    index.reset([
      entry("tstv1-root"),
      entry("tstv1-child", "tstv1-root"),
      entry("tstv1-other"),
    ]);
    await feature.reply({
      sessionID: "tstv1-root",
      requestID: pending.id,
      reply: "reject",
      message: "Keep exact feedback",
    });
    assertEquals(
      store.list(["tstv1-root"], undefined, 101)[0].message,
      "Keep exact feedback",
    );
    assertEquals(
      store.list(["tstv1-root"], undefined, 101)[0].source,
      "manual",
    );
    await assertRejects(
      () =>
        feature.reply({
          sessionID: "tstv1-child",
          requestID: pending.id,
          reply: "once",
        }),
      Error,
      "no longer pending",
    );
    pending = request("failed", "tstv1-root");
    fail = true;
    await assertRejects(
      () =>
        feature.reply({
          sessionID: "tstv1-root",
          requestID: pending.id,
          reply: "once",
        }),
      Error,
      "native failure",
    );
    assertEquals([
      store.list(["tstv1-root"], undefined, 101)[0].outcome,
      store.list(["tstv1-root"], undefined, 101)[0].error,
    ], ["failed", "native failure"]);
    for (
      const [id, rejection] of [["string-failure", "plain rejection"], [
        "undefined-failure",
        undefined,
      ]] as const
    ) {
      pending = request(id, "tstv1-root");
      failure = rejection;
      await feature.reply({
        sessionID: "tstv1-root",
        requestID: pending.id,
        reply: "once",
      }).then(
        () => assert(false, "The reply must reject"),
        (error) => assertEquals(error, rejection),
      );
      assertEquals(
        store.list(["tstv1-root"], undefined, 101)[0].outcome,
        "failed",
        "A non-Error rejection must never be recorded as a confirmed reply",
      );
      assertEquals(store.confirmed("tstv1-root", pending.id), false);
    }
    fail = false;
    for (let n = 0; n < 105; n++) {
      const req = request(`history-${n}`, n % 2 ? "tstv1-child" : "tstv1-root");
      const id = store.start({
        session: req.sessionID,
        requestID: req.id,
        request: JSON.stringify(req),
        reply: "once",
        source: "auto",
        owner: "tstv1-root",
      }, req.sessionID === "tstv1-child" ? ["tstv1-root"] : []);
      store.finish(id, { outcome: "confirmed" });
    }
    index.reset([entry("tstv1-root"), entry("tstv1-other")]);
    const first = await rpc.dispatch("permission.activity", {
      sessionID: "tstv1-root",
    }) as { entries: { id: number }[]; before: number };
    assertEquals(first.entries.length, 100);
    const next = await rpc.dispatch("permission.activity", {
      sessionID: "tstv1-root",
      before: first.before,
    }) as { entries: { id: number }[]; before?: number };
    assertEquals(next.entries.length, 9);
    assertEquals(next.before, undefined);
    assertEquals(
      new Set([...first.entries, ...next.entries].map((row) => row.id)).size,
      109,
    );
    pending = request("uncertain", "tstv1-root");
    hold = deferred<void>();
    const reply = feature.reply({
      sessionID: "tstv1-root",
      requestID: pending.id,
      reply: "once",
    });
    await waitFor(
      () => store.list(["tstv1-root"], undefined, 101)[0].requestID,
      (id) => id === "uncertain",
    );
    feature.close();
    hold.resolve();
    await reply;
    assertEquals(
      store.list(["tstv1-root"], undefined, 101)[0].outcome,
      "started",
      "Shutdown cannot claim an unobserved acknowledgement succeeded",
    );
    assert(
      !belongsToSession("tstv1-child", "tstv1-root", (id) => index.get(id)),
      "The helper is absent from the live family while its historical activity remains complete",
    );
  } finally {
    feature.close();
    db.close();
  }
});
