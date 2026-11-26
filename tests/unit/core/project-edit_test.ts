// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { test } from "../../support/resources.ts";
import { OtkDb, Requests, requestsMigrations } from "@otk/store";
import { RequestCoordinator, RpcRegistry } from "../../../core/mod.ts";
import { registerProjectEdit } from "../../../core/features/project-edit.ts";
import { cfg, fixture } from "./support.ts";
import { stub } from "./rpc_test.ts";
import {
  OperationFailure,
  type ProjectEditSnapshot,
  type RequestEvent,
} from "@otk/protocol";

test("WP9 core gates native project edits and rejects foreign targets and unsupported fields before effects", async () => {
  const db = new OtkDb(await fixture(), [], { busyms: 5000 });
  try {
    const absent = stub(), missing = new RpcRegistry(absent, db);
    registerProjectEdit(missing, absent);
    await assertRejects(() =>
      missing.dispatch("project.settings", { directory: "/fixture" })
    );
    const current: ProjectEditSnapshot = {
      projectID: "fixture",
      directory: "/fixture",
      fields: ["name"],
      values: { name: "Before", icon: "", color: "", startScript: "" },
      colors: [],
      hints: [],
    };
    let effects = 0;
    const harness = stub({
      projectEdit: {
        read: () => Promise.resolve(current),
        update(target, patch) {
          effects++;
          assertEquals(target.projectID, "fixture");
          Object.assign(current.values, patch);
          return Promise.resolve(current);
        },
      },
    });
    const rpc = new RpcRegistry(harness, db);
    registerProjectEdit(rpc, harness);
    for (
      const params of [
        { ...current, projectID: "foreign", patch: { name: "No" } },
        { ...current, patch: { color: "blue" } },
        { ...current, patch: {} },
      ]
    ) await assertRejects(() => rpc.dispatch("project.update", params));
    assertEquals(effects, 0);
    assertEquals(
      await rpc.dispatch("project.update", {
        projectID: "fixture",
        directory: "/fixture",
        patch: { name: "After" },
      }),
      null,
    );
    assertEquals(effects, 1);
    assertEquals(current.values.name, "After");
    assertEquals(
      await rpc.dispatch("project.update", {
        projectID: "fixture",
        directory: "/fixture",
        patch: { name: "" },
      }),
      null,
    );
    assertEquals(effects, 2);
    assertEquals(current.values.name, "");
  } finally {
    db.close();
  }
});

test("superseded native project edit closes as unconfirmed without reading or dispatching again", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations], { busyms: 0 });
  const current: ProjectEditSnapshot = {
    projectID: "fixture",
    directory: "/fixture",
    fields: ["name"],
    values: { name: "Before", icon: "", color: "", startScript: "" },
    colors: [],
    hints: [],
  };
  let calls = 0, reads = 0;
  const harness = stub({
    projectEdit: {
      read() {
        reads++;
        return Promise.resolve(structuredClone(current));
      },
      update(_target, patch) {
        Object.assign(current.values, patch);
        if (++calls === 1) {
          return Promise.reject(
            new OperationFailure(
              "unknown",
              "native.unknown",
              new Error("response lost"),
            ),
          );
        }
        return Promise.resolve(structuredClone(current));
      },
    },
  });
  const registry = new RpcRegistry(harness, db);
  registerProjectEdit(registry, harness);
  const receipts = new Requests(db);
  const requests = new RequestCoordinator({
    registry,
    receipts,
    policy: cfg().requests,
  });
  const events: RequestEvent[] = [];
  const recipient = {
    send: (event: RequestEvent) => events.push(event),
    lease: {
      id: "project-edit",
      signal: new AbortController().signal,
      defer() {},
    },
  };
  try {
    await requests.start();
    const send = async (name: string) => {
      const ref = {
        id: crypto.randomUUID(),
        key: crypto.randomUUID(),
        clientID: crypto.randomUUID(),
        window: requests.window().id,
      };
      await requests.accept("local", {
        t: "request",
        ref,
        method: "project.update",
        params: {
          directory: current.directory,
          projectID: current.projectID,
          patch: { name },
        },
      }, recipient);
      await requests.idle();
      return ref;
    };
    const old = await send("Old");
    const key = {
      principal: "local",
      client_id: old.clientID,
      intent_key: old.key,
    };
    assertEquals(receipts.get(key)?.state, "reconciling");
    await send("New");
    for (let attempt = 0; attempt < 2; attempt++) {
      await requests.accept("local", {
        t: "request.resume",
        items: [{ ref: old, after: 0 }],
      }, recipient);
      await requests.idle();
      const result = events.at(-1);
      assert(result?.t === "request.result" && !result.outcome.ok);
      assertEquals(result.outcome.error.retry, "none");
      assertEquals(result.outcome.error.facts?.outcome, "unknown");
      assertEquals(receipts.get(key)?.state, "failed");
    }
    assertEquals({ calls, reads, name: current.values.name }, {
      calls: 2,
      reads: 2,
      name: "New",
    });
  } finally {
    await requests.stop();
    db.close();
  }
});

test("project edit yields execution while awaiting native validation", async () => {
  const db = new OtkDb(await fixture(), [], { busyms: 0 });
  const current: ProjectEditSnapshot = {
    projectID: "fixture",
    directory: "/fixture",
    fields: ["name"],
    values: { name: "Before", icon: "", color: "", startScript: "" },
    colors: [],
    hints: [],
  };
  const readStarted = Promise.withResolvers<void>();
  const permission = Promise.withResolvers<void>();
  let active = false, writes = 0;
  const harness = stub({
    projectEdit: {
      async read() {
        readStarted.resolve();
        await permission.promise;
        return current;
      },
      update(_target, patch) {
        writes++;
        Object.assign(current.values, patch);
        return Promise.resolve(current);
      },
    },
  });
  const registry = new RpcRegistry(harness, db, (_owner, value) => {
    active = value;
  });
  registerProjectEdit(registry, harness);
  const pending = registry.dispatch(
    "project.update",
    {
      directory: current.directory,
      projectID: current.projectID,
      patch: { name: "After" },
    },
    undefined,
    { signal: new AbortController().signal },
  );
  try {
    await readStarted.promise;
    assertEquals(active, false, "A waiting native read is not executing work");
    assertEquals(writes, 0);
  } finally {
    permission.resolve();
    try {
      await pending;
    } finally {
      db.close();
    }
  }
  assertEquals(writes, 1);
  assertEquals(current.values.name, "After");
});
