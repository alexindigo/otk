// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { Harness } from "@otk/harness";
import type { RequestEvent } from "@otk/protocol";
import { OtkDb, Requests, requestsMigrations } from "@otk/store";
import {
  registerSessions,
  RequestCoordinator,
  RpcRegistry,
} from "../../../core/mod.ts";
import { StorageRequests } from "../../../core/requests/storage.ts";
import {
  ExecutionFailure,
  publicFailure,
} from "../../../core/requests/failures.ts";
import { cfg, fixture } from "./support.ts";
import { test } from "../../support/resources.ts";

test("restart accepts reloadable reads under a retained valid durable window", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations], { busyms: 5000 });
  const durable = new Requests(db);
  // A mutation imported this window before the process restarted.
  const issued = durable.window(Date.now(), cfg().requests.windowms);
  const receipts = new StorageRequests(durable);
  let reads = 0;
  const harness = {
    core: {
      getSession: () => {
        reads++;
        return Promise.resolve({
          id: "tstv1-window",
          directory: "/p",
          projectID: "p",
          title: "Retained session",
          archived: false,
          time: { created: 1, updated: 1 },
        });
      },
    },
  } as unknown as Harness;
  const registry = new RpcRegistry(harness, db);
  registerSessions(registry, harness);
  const coordinator = new RequestCoordinator({
    registry,
    receipts,
    policy: cfg().requests,
  });
  const events: RequestEvent[] = [];
  try {
    await coordinator.start();
    assert(
      receipts.windowInfo(issued.id),
      "The shared authority says the window is valid",
    );
    await coordinator.accept("local", {
      t: "request",
      method: "session.get",
      params: { sessionID: "tstv1-window" },
      ref: {
        id: crypto.randomUUID(),
        key: crypto.randomUUID(),
        clientID: crypto.randomUUID(),
        window: issued.id,
      },
    }, {
      send: (event) => events.push(event),
      lease: {
        id: "window-test",
        signal: new AbortController().signal,
        defer() {},
      },
    });
    await coordinator.idle();
    assertEquals(reads, 1, JSON.stringify(events));
    assert(
      events.some((event) => event.t === "request.result" && event.outcome.ok),
    );
  } finally {
    await coordinator.stop();
    db.close();
  }
});

Deno.test("expired-window failure owns a real reason and safe recovery", () => {
  const failure = publicFailure(
    new ExecutionFailure({ code: "request.expired", retry: "none" }),
    () => {},
  );
  assert(failure.facts?.reason?.includes("Request window expired"));
  assert(failure.facts?.recovery?.includes("before"));
});

test("expired admission preserves action, target, reason and recovery", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations], { busyms: 5000 });
  const receipts = new StorageRequests(new Requests(db));
  const harness = {} as Harness;
  const registry = new RpcRegistry(harness, db);
  registerSessions(registry, harness);
  const coordinator = new RequestCoordinator({
    registry,
    receipts,
    policy: cfg().requests,
  });
  const events: RequestEvent[] = [];
  try {
    await coordinator.start();
    await coordinator.accept("local", {
      t: "request",
      method: "session.get",
      params: { sessionID: "tstv1-window" },
      ref: {
        id: crypto.randomUUID(),
        key: crypto.randomUUID(),
        clientID: crypto.randomUUID(),
        window: crypto.randomUUID(),
      },
    }, {
      send: (event) => events.push(event),
      lease: {
        id: "expired-window-test",
        signal: new AbortController().signal,
        defer() {},
      },
    });
    const rejected = events.find((event) => event.t === "request.rejected");
    assert(rejected?.t === "request.rejected");
    assertEquals(rejected.error.code, "request.expired");
    assertEquals(rejected.error.facts?.action, "session.get");
    assertEquals(rejected.error.facts?.target?.sessionID, "tstv1-window");
    assert(rejected.error.facts?.reason?.includes("Request window expired"));
    assert(rejected.error.facts?.recovery?.includes("before"));
  } finally {
    await coordinator.stop();
    db.close();
  }
});
