// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import type { RequestEvent, RequestRef } from "@otk/protocol";
import {
  OtkDb,
  Prefs,
  prefsMigrations,
  Requests,
  requestsMigrations,
  StorageAvailability,
  StorageFailure,
} from "@otk/store";
import {
  IndexStore,
  prefsOptions,
  RequestCoordinator,
  RpcRegistry,
  startCore,
} from "../../../core/mod.ts";
import { StorageRequests } from "../../../core/requests/storage.ts";
import { test } from "../../support/resources.ts";
import { stub } from "./rpc_test.ts";
import { cfg, fixture } from "./support.ts";

declare module "@otk/protocol" {
  interface RpcMethods {
    "fault.write": { params: { target: string; value: string }; result: null };
  }
  interface RequestReceipts {
    "fault.written": { value: string };
  }
}

async function setup() {
  const root = await fixture();
  const availability = new StorageAvailability();
  const db = new OtkDb(root, [requestsMigrations, prefsMigrations], {
    busyms: 0,
    availability,
  });
  const backend = stub();
  const registry = new RpcRegistry(backend, db);
  const receipts = new Requests(db);
  db.connection.exec(
    "CREATE TABLE writes (target TEXT PRIMARY KEY, value TEXT)",
  );
  const blocked = new Set<string>();
  const commits: string[] = [];
  const fault = new StorageFailure("io", `${root}/otk.db`, "write", undefined);
  registry.register("fault.write", {
    params: (p) => ({ target: String(p.target), value: String(p.value) }),
    execution: {
      kind: "local",
      ordering: "target",
      scope: (p) => ({ resource: p.target, sessionID: "tstv1-fixture" }),
      receipt: () => undefined,
      completion: (receipt) => receipt,
      recover: () => Promise.resolve({ state: "complete", result: null }),
    },
    handler: (ctx, p) =>
      ctx.execution!.local((tx) => {
        db.connection.prepare("INSERT OR REPLACE INTO writes VALUES (?,?)").run(
          p.target,
          p.value,
        );
        db.afterCommit(tx, () => commits.push(p.value));
        if (blocked.has(p.value)) throw fault;
        return null;
      }, () => ({ kind: "fault.written", value: { value: p.value } })),
  });
  const events: RequestEvent[] = [];
  const recipient = {
    send: (event: RequestEvent) => events.push(event),
    lease: { id: "storage", signal: new AbortController().signal, defer() {} },
  };
  const send = async (
    requests: RequestCoordinator,
    target: string,
    value: string,
    ref: RequestRef = {
      id: crypto.randomUUID(),
      clientID: crypto.randomUUID(),
      key: crypto.randomUUID(),
      window: requests.window().id,
    },
  ) => {
    await requests.accept("local", {
      t: "request",
      ref,
      method: "fault.write",
      params: { target, value },
    }, recipient);
    return ref;
  };
  const make = () =>
    new RequestCoordinator({
      registry,
      receipts: new StorageRequests(receipts),
      policy: cfg().requests,
    });
  return {
    root,
    db,
    backend,
    registry,
    receipts,
    fault,
    blocked,
    commits,
    events,
    send,
    make,
  };
}

test("a storage-parked local write keeps its target order, not the executing turn", async () => {
  const f = await setup(), requests = f.make();
  try {
    await requests.start();
    f.blocked.add("old");
    const old = await f.send(requests, "same", "old");
    await requests.idle();
    const newer = await f.send(requests, "same", "new");
    const independent = await f.send(requests, "other", "independent");
    await requests.idle();
    assertEquals(f.commits, ["independent"]);
    f.blocked.clear();
    requests.storageRecovered();
    await requests.idle();
    assertEquals(f.commits, ["independent", "old", "new"]);
    assertEquals(
      f.db.connection.prepare("SELECT value FROM writes WHERE target=?").get(
        "same",
      )?.value,
      "new",
    );
    assertEquals(
      f.events.flatMap((event) =>
        event.t === "request.result" && event.outcome.ok ? [event.ref.key] : []
      ),
      [independent.key, old.key, newer.key],
    );
  } finally {
    await requests.stop();
    f.db.close();
  }
});

test("durable target order survives restart when the newer input is resupplied first", async () => {
  const f = await setup(), original = f.make();
  let restarted: RequestCoordinator | undefined;
  try {
    await original.start();
    const window = original.window().id;
    // These keys sort in reverse admission order. Force a page boundary too.
    const client = (prefix: string) =>
      `${prefix}0000000-0000-4000-8000-000000000000`;
    const old = {
      id: crypto.randomUUID(),
      clientID: client("f"),
      key: crypto.randomUUID(),
      window,
    };
    const newer = {
      id: crypto.randomUUID(),
      clientID: client("a"),
      key: crypto.randomUUID(),
      window,
    };
    f.blocked.add("old").add("new");
    await f.send(original, "same", "old", old);
    await original.idle();
    await f.send(original, "same", "new", newer);
    await original.idle();
    await original.stop();
    f.blocked.clear();
    restarted = f.make();
    restarted.options.policy.resumebatch = 1;
    await restarted.start();
    await f.send(restarted, "same", "new", newer);
    await restarted.idle();
    assertEquals(f.commits, []);
    await f.send(restarted, "same", "old", old);
    await restarted.idle();
    assertEquals(f.commits, ["old", "new"]);
  } finally {
    await original.stop();
    await restarted?.stop();
    f.db.close();
  }
});

test("a failed receipt refresh keeps its own retry and does not skip the rest of the sweep", async () => {
  const f = await setup(), requests = f.make();
  try {
    await requests.start();
    f.blocked.add("first");
    f.blocked.add("second");
    const first = await f.send(requests, "a", "first");
    await requests.idle();
    await f.send(requests, "b", "second");
    await requests.idle();
    f.blocked.clear();
    let fail = true;
    const get = f.receipts.get.bind(f.receipts);
    f.receipts.get = (key) => {
      if (fail && key.intent_key === first.key) {
        fail = false;
        throw f.fault;
      }
      return get(key);
    };
    requests.storageRecovered();
    await requests.idle();
    const firstSweep = [...f.commits];
    requests.maintenance();
    await requests.idle();
    assertEquals({ firstSweep, final: f.commits }, {
      firstSweep: ["second"],
      final: ["second", "first"],
    });
  } finally {
    await requests.stop();
    f.db.close();
  }
});

test("index replay failure cannot veto request storage recovery in the service", async () => {
  const f = await setup();
  const index = new IndexStore();
  const settings = cfg();
  settings.server.port = 0;
  settings.auth.type = "none";
  const service = await startCore({
    cfg: settings,
    backend: f.backend,
    store: f.db,
    prefs: new Prefs(f.db, prefsOptions),
    rpc: f.registry,
    staticRoot: f.root,
    index,
  });
  try {
    let replays = 0;
    index.resetMetadata = () => {
      replays++;
      throw new Error("index observer failed");
    };
    f.blocked.add("pending");
    const ref = await f.send(service.requests, "target", "pending");
    await service.requests.idle();
    const pages =
      f.db.connection.prepare("PRAGMA page_count").get()!.page_count;
    f.db.connection.exec(`PRAGMA max_page_count=${pages}`);
    assertThrows(() => f.db.probe(), StorageFailure);
    f.blocked.clear();
    f.db.connection.exec("PRAGMA max_page_count=1073741823");
    f.db.availability.probe();
    await service.requests.idle();
    assertEquals(replays, 1);
    assertEquals(f.commits, ["pending"]);
    assertEquals(f.events.at(-1)?.t, "request.result");
    assertEquals(f.events.at(-1)?.ref.key, ref.key);
  } finally {
    await service.stop();
  }
});
