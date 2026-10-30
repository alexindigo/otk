// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  OtkDb,
  Requests,
  requestsMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { RequestCoordinator, RpcRegistry } from "../../../core/mod.ts";
import type { Harness } from "@otk/harness";
import type { RequestEvent } from "@otk/protocol";
import { test } from "../../support/resources.ts";
import { fixture } from "./support.ts";

declare module "@otk/protocol" {
  interface RpcMethods {
    "requests.example": { params: { title: string }; result: string };
    "requests.observe": { params: { title: string }; result: string };
  }
  interface RequestReceipts {
    "example-id": { id: string };
  }
}

test("coordinator acknowledges before work, deduplicates and atomically replays original local result", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations, tasksMigrations]);
  const receipts = new Requests(db), tasks = new Tasks(db);
  const registry = new RpcRegistry({} as Harness, db);
  let effects = 0;
  registry.register("requests.example", {
    params: (p) => ({ title: String(p.title) }),
    execution: {
      kind: "local",
      scope: () => ({ directory: "/p" }),
      receipt: (id) => ({ kind: "example-id", value: { id } }),
      recover: (_ctx, record) =>
        Promise.resolve({
          state: "complete",
          result: JSON.parse(record.receipt_json!).id,
        }),
    },
    handler: (ctx, p) =>
      ctx.execution!.local((tx) => {
        effects++;
        return tasks.create("/p", p.title, [], tx).id;
      }, (id) => ({ kind: "example-id", value: { id } })),
  });
  const coordinator = new RequestCoordinator({
    registry,
    receipts,
    policy: {
      windowms: 10000,
      retentionms: 10000,
      maxpending: 8,
      inputbytes: 10000,
      resultbytes: 10000,
      resumebatch: 8,
      sweepbatch: 8,
      livenessms: 1000,
      stoppingms: 1000,
    },
  });
  await coordinator.start();
  const window = coordinator.window();
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: window.id,
  };
  const events: RequestEvent[] = [];
  const recipient = {
    send(event: RequestEvent) {
      events.push(event);
    },
    lease: { id: "socket", signal: new AbortController().signal, defer() {} },
  };
  try {
    await coordinator.accept("local", {
      t: "request",
      ref,
      method: "requests.example",
      params: { title: "perf" },
    }, recipient);
    assertEquals(events[0].t, "request.accepted");
    assertEquals(effects, 0);
    await coordinator.idle();
    assertEquals(effects, 1);
    assertEquals(events.at(-1)?.t, "request.result");
    coordinator.detach(recipient);
    await coordinator.accept("local", {
      t: "request",
      ref: { ...ref, id: crypto.randomUUID() },
      method: "requests.example",
      params: { title: "perf" },
    }, recipient);
    await coordinator.idle();
    assertEquals(effects, 1);
    assertEquals(tasks.list("/p").length, 1);
    assertEquals(events.at(-1)?.t, "request.result");
    await coordinator.accept("local", {
      t: "request",
      ref,
      method: "requests.example",
      params: { title: "changed" },
    }, recipient);
    assertEquals(events.at(-1)?.t, "request.rejected");
  } finally {
    await coordinator.stop();
    db.close();
  }
});

for (const heldKind of ["effect", "read"] as const) {
  test(`session effect FIFO is independent of a held ${heldKind} observation lifetime`, async () => {
    const db = new OtkDb(await fixture(), [requestsMigrations]);
    const receipts = new Requests(db),
      registry = new RpcRegistry({} as Harness, db);
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const calls: string[] = [];
    const scope = () => ({ sessionID: "opcv1-requests-observation" });
    registry.register("requests.example", {
      params: (p) => ({ title: String(p.title) }),
      execution: {
        kind: "native",
        scope,
        receipt: (id) => ({ kind: "example-id", value: { id } }),
        recover: () =>
          Promise.resolve({
            state: "pending",
            progress: { phase: "reconciling", code: "checking-outcome" },
          }),
      },
      handler: async (ctx, p) => {
        await ctx.execution!.beforeEffect();
        calls.push(`effect:${p.title}`);
        if (heldKind === "effect" && p.title === "first") {
          entered.resolve();
          await held.promise;
        }
        return p.title;
      },
    });
    registry.register("requests.observe", {
      params: (p) => ({ title: String(p.title) }),
      execution: {
        kind: "read",
        scope,
        receipt: () => undefined,
        recover: () => Promise.resolve({ state: "reload" }),
      },
      handler: async (_ctx, p) => {
        calls.push(`read:${p.title}`);
        if (heldKind === "read") {
          entered.resolve();
          await held.promise;
        }
        return p.title;
      },
    });
    const coordinator = new RequestCoordinator({
      registry,
      receipts,
      policy: {
        windowms: 10000,
        retentionms: 10000,
        maxpending: 8,
        inputbytes: 10000,
        resultbytes: 10000,
        resumebatch: 8,
        sweepbatch: 8,
        livenessms: 1000,
        stoppingms: 1000,
      },
    });
    await coordinator.start();
    const events: RequestEvent[] = [];
    const recipient = {
      send: (event: RequestEvent) => {
        events.push(event);
      },
      lease: { id: "scope", signal: new AbortController().signal, defer() {} },
    };
    const admit = (
      method: "requests.example" | "requests.observe",
      title: string,
    ) =>
      coordinator.accept("local", {
        t: "request",
        ref: {
          id: crypto.randomUUID(),
          clientID: crypto.randomUUID(),
          key: crypto.randomUUID(),
          window: coordinator.window().id,
        },
        method,
        params: { title },
      }, recipient);
    try {
      await admit(
        heldKind === "effect" ? "requests.example" : "requests.observe",
        "first",
      );
      await entered.promise;
      if (heldKind === "effect") {
        await admit("requests.example", "second");
        await admit("requests.observe", "peek");
      } else await admit("requests.example", "second");
      // Drain already-posted dispatch turns while the original lifetime is held.
      for (let turn = 0; turn < 4; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assertEquals(
        calls,
        heldKind === "effect"
          ? ["effect:first", "read:peek"]
          : ["read:first", "effect:second"],
      );
      assertEquals(
        events.filter((event) => event.t === "request.result").length,
        1,
      );
      held.resolve();
      await coordinator.idle();
      assertEquals(
        calls,
        heldKind === "effect"
          ? ["effect:first", "read:peek", "effect:second"]
          : ["read:first", "effect:second"],
      );
      assertEquals(
        events.filter((event) => event.t === "request.result").length,
        heldKind === "effect" ? 3 : 2,
      );
    } finally {
      held.resolve();
      await coordinator.stop();
      db.close();
    }
  });
}
