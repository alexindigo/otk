// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  OtkDb,
  pluginStorageMigrations,
  PluginStore,
  type RequestRecord,
  Requests,
  requestsMigrations,
  StorageAvailability,
  StorageFailure,
} from "@otk/store";
import type { Harness } from "@otk/harness";
import type { RequestEvent, ServerFrame } from "@otk/protocol";
import { NotificationHub, storageFailureNote } from "@otk/client";
import { publicFailure } from "../../../core/requests/failures.ts";
import {
  readExecution,
  RequestCoordinator,
  RpcRegistry,
} from "../../../core/mod.ts";
import { StorageRequests } from "../../../core/requests/storage.ts";
import { StorageFeature } from "../../../core/features/storage.ts";
import { test } from "../../support/resources.ts";
import { cfg, fixture } from "./support.ts";
import { requestFingerprint } from "@otk/protocol";

declare module "@otk/protocol" {
  interface RpcMethods {
    "storage.read": { params: Record<string, never>; result: string };
    "storage.write": { params: Record<string, never>; result: null };
  }
  interface RequestReceipts {
    "storage.saved": { saved: boolean };
  }
}

test("a disconnected notice recipient cannot veto storage recovery or another recipient", () => {
  const owner = new StorageAvailability();
  let recovered = 0, received = 0;
  const source = new StorageFeature(owner, 60_000, () => {
    recovered++;
  });
  const unregister = owner.register("notice-test", () => {});
  source.listen(() => {
    throw new Error("Recipient disconnected");
  });
  source.listen(() => {
    received++;
  });
  try {
    owner.failed(new StorageFailure("full", "notice-test", "write", undefined));
    owner.probe();
    assertEquals(recovered, 1);
    assertEquals(received, 2);
    assertEquals(owner.status().degraded, false);
  } finally {
    source.close();
    unregister();
  }
});

test("storage failures reach request consumers with an actionable non-success outcome", async () => {
  const db = new OtkDb(await fixture(), [pluginStorageMigrations], {
    busyms: 0,
  });
  try {
    const plugin = new PluginStore(db).scope("storage-full");
    const pages = Number(
      db.connection.prepare("PRAGMA page_count").get()!.page_count,
    );
    db.connection.exec(`PRAGMA max_page_count=${pages}`);
    const error = assertThrows(() =>
      plugin.set("lost", "x".repeat(1024 * 1024))
    );
    const failure = publicFailure(error, () => {});
    assertEquals(failure.code, "storage.full");
    assertEquals(
      failure.facts?.reason,
      "Storage is full: OTK can't save changes. Free disk space; OTK resumes automatically.",
    );
    assertEquals(plugin.get("lost"), undefined);
  } finally {
    db.close();
  }
});

test("reloadable reads and windows stay volatile while mutation admission remains durable", async () => {
  const owner = new StorageAvailability();
  const db = new OtkDb(await fixture(), [
    requestsMigrations,
    pluginStorageMigrations,
  ], { busyms: 0, availability: owner });
  const registry = new RpcRegistry({} as Harness, db);
  const plugin = new PluginStore(db).scope("storage-test");
  const receipts = new StorageRequests(new Requests(db));
  let blocked = false;
  const exec = db.connection.exec;
  db.connection.exec = (sql) => {
    if (blocked && sql === "BEGIN IMMEDIATE") {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
    return exec(sql);
  };
  registry.register("storage.read", {
    params: () => ({}),
    execution: readExecution(() => ({})),
    handler: () => "still readable",
  });
  registry.register("storage.write", {
    params: () => ({}),
    execution: {
      kind: "local",
      scope: () => ({}),
      receipt: () => ({ kind: "storage.saved", value: { saved: true } }),
      recover: () => Promise.resolve({ state: "complete", result: null }),
    },
    handler: (ctx) =>
      ctx.execution!.local(() => {
        db.connection.prepare(
          "INSERT OR REPLACE INTO plugin_storage VALUES('storage-test','saved','yes')",
        ).run();
        return null;
      }, () => ({ kind: "storage.saved", value: { saved: true } })),
  });
  const coordinator = new RequestCoordinator({
    registry,
    receipts,
    policy: cfg().requests,
  });
  await coordinator.start();
  const events: RequestEvent[] = [];
  const recipient = {
    send: (event: RequestEvent) => events.push(event),
    lease: { id: "storage", signal: new AbortController().signal, defer() {} },
  };
  const frames: ServerFrame[] = [];
  const source = new StorageFeature(
    owner,
    60_000,
    () => coordinator.storageRecovered(),
  );
  const stop = source.listen((frame) => frames.push(frame));
  try {
    blocked = true;
    const ref = {
      id: crypto.randomUUID(),
      clientID: crypto.randomUUID(),
      key: crypto.randomUUID(),
      window: coordinator.window().id,
    };
    await coordinator.accept("local", {
      t: "request",
      ref,
      method: "storage.write",
      params: {},
    }, recipient);
    assertEquals(events.at(-1)?.t, "request.rejected");
    assertEquals(
      events.filter((event) => event.t === "request.accepted").length,
      0,
    );
    assertEquals(owner.status().degraded, true);
    await coordinator.accept("local", {
      t: "request",
      ref: { ...ref, key: crypto.randomUUID() },
      method: "storage.read",
      params: {},
    }, recipient);
    await coordinator.idle();
    const result = events.at(-1);
    assert(result?.t === "request.result" && result.outcome.ok);
    assertEquals(result.outcome.result, "still readable");
    assertEquals(
      db.connection.prepare("SELECT COUNT(*) AS count FROM request_receipts")
        .get()!.count,
      0,
    );
    owner.probe();
    assertEquals(
      owner.status().degraded,
      true,
      "a failed real probe cannot clear degraded state",
    );
    blocked = false;
    owner.probe();
    assertEquals(owner.status().degraded, false);
    const storageFrames = frames.filter((frame) => frame.t === "storage");
    assertEquals(storageFrames.map((frame) => frame.state.degraded), [
      true,
      false,
    ]);
    assertEquals(storageFrames[1].state.gap, 1);
    await coordinator.accept("local", {
      t: "request",
      ref,
      method: "storage.write",
      params: {},
    }, recipient);
    await coordinator.idle();
    const saved = events.at(-1);
    assert(saved?.t === "request.result" && saved.outcome.ok);
    assertEquals(plugin.get("saved"), "yes");
  } finally {
    blocked = false;
    stop();
    source.close();
    await coordinator.stop();
    db.close();
  }
});

test("a failed local completion stays unacknowledged until recovery commits effect and receipt together", async () => {
  const owner = new StorageAvailability();
  const db = new OtkDb(await fixture(), [
    requestsMigrations,
    pluginStorageMigrations,
  ], { busyms: 0, availability: owner });
  const registry = new RpcRegistry({} as Harness, db);
  let first = true, blockCommit = false, published = 0;
  const exec = db.connection.exec;
  db.connection.exec = (sql) => {
    if (blockCommit && sql === "COMMIT") {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
    return exec(sql);
  };
  registry.register("storage.write", {
    params: () => ({}),
    execution: {
      kind: "local",
      scope: () => ({}),
      receipt: () => ({ kind: "storage.saved", value: { saved: true } }),
      recover: () => Promise.resolve({ state: "complete", result: null }),
    },
    handler: (ctx) =>
      ctx.execution!.local((tx) => {
        if (first) {
          blockCommit = true;
          first = false;
        }
        db.connection.prepare(
          "INSERT INTO plugin_storage VALUES('completion','saved','yes')",
        ).run();
        db.afterCommit(tx, () => {
          published++;
        });
        return null;
      }, () => ({ kind: "storage.saved", value: { saved: true } })),
  });
  const durable = new Requests(db);
  const coordinator = new RequestCoordinator({
    registry,
    receipts: new StorageRequests(durable),
    policy: cfg().requests,
  });
  const source = new StorageFeature(
    owner,
    60_000,
    () => coordinator.storageRecovered(),
  );
  const events: RequestEvent[] = [];
  const recipient = {
    send: (event: RequestEvent) => events.push(event),
    lease: {
      id: "completion",
      signal: new AbortController().signal,
      defer() {},
    },
  };
  try {
    await coordinator.start();
    const ref = {
      id: crypto.randomUUID(),
      clientID: crypto.randomUUID(),
      key: crypto.randomUUID(),
      window: coordinator.window().id,
    };
    await coordinator.accept("local", {
      t: "request",
      ref,
      method: "storage.write",
      params: {},
    }, recipient);
    await coordinator.idle();
    assertEquals(owner.status().degraded, true);
    assertEquals(published, 0);
    assertEquals(events.some((event) => event.t === "request.result"), false);
    const key = {
      principal: "local",
      client_id: ref.clientID,
      intent_key: ref.key,
    };
    assertEquals(durable.get(key)!.state, "running");
    assertEquals(
      new PluginStore(db).scope("completion").get("saved"),
      undefined,
    );
    blockCommit = false;
    owner.probe();
    await coordinator.idle();
    assertEquals(published, 1);
    assertEquals(durable.get(key)!.state, "succeeded");
    assertEquals(new PluginStore(db).scope("completion").get("saved"), "yes");
    const result = events.at(-1);
    assert(result?.t === "request.result" && result.outcome.ok);
    // Receipt replay never reapplies the committed local effect.
    await coordinator.accept("local", {
      t: "request",
      ref: { ...ref, id: crypto.randomUUID() },
      method: "storage.write",
      params: {},
    }, recipient);
    await coordinator.idle();
    assertEquals(published, 1);
  } finally {
    blockCommit = false;
    source.close();
    await coordinator.stop();
    db.close();
  }
});

test("the existing failure owner retains one replaceable storage notice and exposes the observation gap on recovery", async () => {
  const db = new OtkDb(await fixture(), [pluginStorageMigrations], {
    busyms: 0,
  });
  try {
    const pages = Number(
      db.connection.prepare("PRAGMA page_count").get()!.page_count,
    );
    db.connection.exec(`PRAGMA max_page_count=${pages}`);
    const failure = publicFailure(
      assertThrows(() =>
        new PluginStore(db).scope("full").set("large", "x".repeat(1024 * 1024))
      ),
      () => {},
    );
    const deliveries = new Map<string, string>();
    const hub = new NotificationHub(
      () => ({ channels: ["test"] }),
      () => Promise.resolve(),
      () => {},
    );
    hub.registerChannel({
      id: "test",
      available: () => true,
      deliver: (note) => {
        deliveries.set(note.id, note.title);
      },
      retract: (id) => {
        deliveries.delete(id);
      },
    });
    for (let n = 0; n < 10; n++) {
      hub.publish(
        storageFailureNote("local", { degraded: true, gap: 1, failure })!,
      );
    }
    assertEquals(deliveries.size, 1);
    assert(
      [...deliveries.values()][0].includes(
        "Storage is full: OTK can't save changes. Free disk space; OTK resumes automatically.",
      ),
    );
    hub.publish(storageFailureNote("local", { degraded: false, gap: 1 })!);
    assertEquals(deliveries.size, 1);
    assert([...deliveries.values()][0].includes("Observation was interrupted"));
    hub.stop();
  } finally {
    db.close();
  }
});

test("storage recovery never redispatches an uncertain native mutation", async () => {
  const owner = new StorageAvailability();
  const db = new OtkDb(await fixture(), [requestsMigrations], {
    busyms: 0,
    availability: owner,
  });
  const registry = new RpcRegistry({} as Harness, db);
  let blockCommit = false, calls = 0, reconciliations = 0;
  const exec = db.connection.exec;
  db.connection.exec = (sql) => {
    if (blockCommit && sql === "COMMIT") {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    }
    exec(sql);
  };
  registry.register("storage.write", {
    params: () => ({}),
    execution: {
      kind: "native",
      scope: () => ({}),
      receipt: () => ({ kind: "storage.saved", value: { saved: true } }),
      recover: () => {
        reconciliations++;
        return Promise.resolve({
          state: "pending",
          progress: { phase: "reconciling", code: "checking-outcome" },
        });
      },
    },
    handler: async (ctx) => {
      await ctx.execution!.beforeEffect();
      calls++;
      blockCommit = true;
      return null;
    },
  });
  const durable = new Requests(db);
  const coordinator = new RequestCoordinator({
    registry,
    receipts: new StorageRequests(durable),
    policy: cfg().requests,
  });
  const source = new StorageFeature(
    owner,
    60_000,
    () => coordinator.storageRecovered(),
  );
  const events: RequestEvent[] = [];
  const recipient = {
    send: (event: RequestEvent) => events.push(event),
    lease: { id: "native", signal: new AbortController().signal, defer() {} },
  };
  try {
    await coordinator.start();
    const ref = {
      id: crypto.randomUUID(),
      key: crypto.randomUUID(),
      clientID: crypto.randomUUID(),
      window: coordinator.window().id,
    };
    await coordinator.accept("local", {
      t: "request",
      ref,
      method: "storage.write",
      params: {},
    }, recipient);
    await coordinator.idle();
    assertEquals(calls, 1);
    assertEquals(events.some((event) => event.t === "request.result"), false);
    blockCommit = false;
    owner.probe();
    await coordinator.idle();
    assertEquals(calls, 1);
    assertEquals(reconciliations, 1);
    assertEquals(events.some((event) => event.t === "request.result"), false);
    assertEquals(
      durable.get({
        principal: "local",
        client_id: ref.clientID,
        intent_key: ref.key,
      })!.state,
      "reconciling",
    );
  } finally {
    blockCommit = false;
    source.close();
    await coordinator.stop();
    db.close();
  }
});

test("retained read identities from an older durable coordinator replay without a write after upgrade", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations], {
    busyms: 0,
    availability: new StorageAvailability(),
  });
  const durable = new Requests(db), now = Date.now();
  const window = durable.window(now, 60_000);
  const old: RequestRecord = {
    principal: "local",
    client_id: crypto.randomUUID(),
    intent_key: crypto.randomUUID(),
    window_id: window.id,
    state: "queued",
    seq: 1,
    dispatched_at: null,
    owner_run: null,
    scope_session: null,
    scope_directory: null,
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
    error_facts: null,
    origin: null,
    execution: "read" as const,
    method: "storage.read",
    fingerprint: await requestFingerprint("{}"),
    accepted_at: now,
    updated_at: now,
    retention_until: now + 120_000,
  };
  durable.admit(old);
  const registry = new RpcRegistry({} as Harness, db);
  registry.register("storage.read", {
    params: () => ({}),
    execution: readExecution(() => ({})),
    handler: () => "reloaded",
  });
  const exec = db.connection.exec;
  db.connection.exec = (sql) => {
    if (sql === "BEGIN IMMEDIATE") {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    }
    exec(sql);
  };
  const coordinator = new RequestCoordinator({
    registry,
    receipts: new StorageRequests(durable),
    policy: cfg().requests,
  });
  const events: RequestEvent[] = [];
  const recipient = {
    send: (event: RequestEvent) => events.push(event),
    lease: { id: "legacy", signal: new AbortController().signal, defer() {} },
  };
  try {
    assertThrows(() => db.transaction(() => {}));
    await coordinator.start();
    await coordinator.accept(old.principal, {
      t: "request",
      ref: {
        id: crypto.randomUUID(),
        key: old.intent_key,
        clientID: old.client_id,
        window: old.window_id,
      },
      method: "storage.read",
      params: {},
    }, recipient);
    await coordinator.idle();
    const result = events.at(-1);
    assert(result?.t === "request.result" && result.outcome.ok);
    assertEquals(result.outcome.result, "reloaded");
  } finally {
    await coordinator.stop();
    db.connection.exec = exec;
    db.close();
  }
});
