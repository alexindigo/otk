// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { OperationFailure } from "@otk/protocol";
import type { Harness } from "@otk/harness";
import type { RequestEvent } from "@otk/protocol";
import {
  OtkDb,
  permissionMigrations,
  PermissionStore,
  Requests,
  requestsMigrations,
} from "@otk/store";
import {
  IndexStore,
  RequestCoordinator,
  RpcRegistry,
} from "../../../core/mod.ts";
import { PermissionFeature } from "../../../core/features/approvals.ts";
import { registerDigests } from "../../../core/features/digests.ts";
import { test } from "../../support/resources.ts";
import { cfg, fixture } from "./support.ts";

test("auto-approve commits its receipt before automatic work, and activity is a volatile read", async () => {
  const db = new OtkDb(await fixture(), [
    permissionMigrations,
    requestsMigrations,
  ]);
  const store = new PermissionStore(db), receipts = new Requests(db);
  const ref = { clientID: crypto.randomUUID(), key: crypto.randomUUID() };
  let automaticReads = 0;
  const capability = {
    listPermissions: () => {
      automaticReads++;
      assertEquals(
        receipts.get({
          principal: "local",
          client_id: ref.clientID,
          intent_key: ref.key,
        })?.state,
        "succeeded",
      );
      return Promise.resolve([]);
    },
    replyPermission: () => Promise.resolve(),
  };
  const harness = {
    core: {
      getSession: () => Promise.resolve({ id: "tstv1-root", directory: "/p" }),
      identities: () =>
        Promise.resolve([{ id: "tstv1-root", directory: "/p" }]),
    },
    capabilities: { permissions: capability },
  } as unknown as Harness;
  const registry = new RpcRegistry(harness, db);
  const feature = new PermissionFeature(store, new IndexStore(), capability);
  feature.register(registry);
  let coordinator = new RequestCoordinator({
    registry,
    receipts,
    policy: cfg().requests,
  });
  await coordinator.start();
  const request = {
    id: crypto.randomUUID(),
    ...ref,
    window: coordinator.window().id,
  };
  const events: RequestEvent[] = [];
  const recipient = {
    send: (event: RequestEvent) => events.push(event),
    lease: { id: "socket", signal: new AbortController().signal, defer() {} },
  };
  try {
    assertEquals(registry.policy("permission.auto")?.kind, "local");
    assertEquals(registry.policy("permission.activity")?.kind, "read");
    await coordinator.accept("local", {
      t: "request",
      ref: request,
      method: "permission.auto",
      params: { sessionID: "tstv1-root", enabled: true },
    }, recipient);
    await coordinator.idle();
    const terminal = events.at(-1);
    assert(terminal?.t === "request.result" && terminal.outcome.ok);
    assertEquals(terminal.outcome.result, feature.get());
    assertEquals(store.enabled(), ["tstv1-root"]);
    assertEquals(automaticReads, 1);
    await coordinator.stop();
    coordinator = new RequestCoordinator({
      registry,
      receipts,
      policy: cfg().requests,
    });
    await coordinator.start();
    await coordinator.accept("local", {
      t: "request.resume",
      items: [{ ref: request, after: 0 }],
    }, recipient);
    await coordinator.idle();
    assertEquals(automaticReads, 1);
    assertEquals(events.at(-1), terminal);
  } finally {
    await coordinator.stop();
    feature.close();
    db.close();
  }
});

test("digest request leases release their connection and are never reapplied during receipt recovery", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations]);
  const scopes: string[] = [],
    releases: string[] = [],
    callbacks: (() => void)[] = [];
  const harness = {
    capabilities: {
      digests: {
        scope: (id: string) => scopes.push(id),
        release: (id: string) => releases.push(id),
      },
    },
  } as unknown as Harness;
  const registry = new RpcRegistry(harness, db);
  registerDigests(registry, harness);
  const receipts = new Requests(db);
  let coordinator = new RequestCoordinator({
    registry,
    receipts,
    policy: cfg().requests,
  });
  await coordinator.start();
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: coordinator.window().id,
  };
  const events: RequestEvent[] = [];
  const recipient = {
    send: (event: RequestEvent) => events.push(event),
    lease: {
      id: "first",
      signal: new AbortController().signal,
      defer: (release: () => void) => {
        callbacks.push(release);
      },
    },
  };
  try {
    assertEquals(registry.policy("digests.scope")?.kind, "lease");
    await coordinator.accept("local", {
      t: "request",
      ref,
      method: "digests.scope",
      params: { directory: "/p", sessions: ["tstv1-root"] },
    }, recipient);
    await coordinator.idle();
    assertEquals(scopes, ["first"]);
    coordinator.detach(recipient);
    callbacks.forEach((release) => release());
    assertEquals(releases, ["first"]);
    await coordinator.stop();
    coordinator = new RequestCoordinator({
      registry,
      receipts,
      policy: cfg().requests,
    });
    await coordinator.start();
    await coordinator.accept("local", {
      t: "request.resume",
      items: [{ ref, after: 0 }],
    }, { ...recipient, lease: { ...recipient.lease, id: "second" } });
    await coordinator.idle();
    assertEquals(scopes, ["first"]);
    const result = events.at(-1);
    assert(result?.t === "request.result" && result.outcome.ok);
  } finally {
    await coordinator.stop();
    db.close();
  }
});

test("unconfirmed permission replies survive feature replacement without automatic redispatch", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations]);
  const store = new PermissionStore(db), index = new IndexStore();
  let calls = 0;
  const request = {
    id: "ask",
    sessionID: "tstv1-root",
    kind: "bash",
    title: "bash",
    time: 1,
    patterns: [],
    alwaysPatterns: [],
    detail: { kind: "bash" as const, command: "private command" },
  };
  const capability = {
    listPermissions: () => Promise.resolve([request]),
    replyPermission: () => {
      calls++;
      throw new OperationFailure(
        "unknown",
        "native.unknown",
        new Error("lost response"),
      );
    },
  };
  let feature = new PermissionFeature(store, index, capability);
  const operation = {
    key: {
      clientID: crypto.randomUUID(),
      key: crypto.randomUUID(),
      window: crypto.randomUUID(),
    },
    signal: new AbortController().signal,
    progress() {},
    beforeEffect: () => Promise.resolve(),
    checkpoint: () => Promise.resolve(),
  };
  try {
    await assertRejects(() =>
      feature.reply({
        sessionID: request.sessionID,
        requestID: request.id,
        reply: "once",
      }, operation)
    );
    assertEquals(store.list([request.sessionID])[0].outcome, "started");
    feature.close();
    feature = new PermissionFeature(store, index, capability);
    const harness = {
      core: {
        identities: () =>
          Promise.resolve([{ id: request.sessionID, directory: "/p" }]),
      },
      capabilities: { permissions: capability },
    } as unknown as Harness;
    const rpc = new RpcRegistry(harness, db);
    feature.register(rpc);
    await rpc.dispatch("permission.auto", {
      sessionID: request.sessionID,
      enabled: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(calls, 1);
    assertEquals(store.list([request.sessionID]).length, 1);
  } finally {
    feature.close();
    db.close();
  }
});
