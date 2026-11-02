// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  OtkDb,
  Requests,
  requestsMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import {
  mappedReceipt,
  nativeEffect,
  RequestCoordinator,
  RpcRegistry,
} from "../../../core/mod.ts";
import type { Harness } from "@otk/harness";
import type { RequestEvent } from "@otk/protocol";
import { test } from "../../support/resources.ts";
import { fixture } from "./support.ts";

declare module "@otk/protocol" {
  interface RpcMethods {
    "requests.example": { params: { title: string }; result: string };
    "requests.observe": { params: { title: string }; result: string };
    "requests.local": { params: { title: string }; result: string };
    "requests.barrier": { params: { title: string }; result: string };
  }
  interface RequestReceipts {
    "example-id": { id: string };
  }
}

test("coordinator acknowledges before work, deduplicates and atomically replays original local result", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations, tasksMigrations], {
    busyms: 5000,
  });
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
    const db = new OtkDb(await fixture(), [requestsMigrations], {
      busyms: 5000,
    });
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

for (const heldClass of ["native", "prepared-local"] as const) {
  test(`readiness yields the session turn to local effects while ${heldClass} effects retain their ordering permission`, async () => {
    const db = new OtkDb(await fixture(), [requestsMigrations], {
      busyms: 5000,
    });
    const registry = new RpcRegistry({} as Harness, db);
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const calls: string[] = [];
    const scope = () => ({ sessionID: "tstv1-yield" });
    const completion = mappedReceipt(
      "example-id",
      (value) => {
        if (
          !value || typeof value !== "object" || !("id" in value) ||
          typeof value.id !== "string"
        ) throw new TypeError("Expected example identity");
        return { id: value.id };
      },
      (id: string) => ({ id }),
      (value) => value.id,
    );
    registry.register("requests.example", {
      params: (p) => ({ title: String(p.title) }),
      execution: {
        kind: heldClass,
        ordering: heldClass === "prepared-local" ? "target" : undefined,
        scope,
        checkpoint: completion.validate,
        receipt: (id) => ({ kind: "example-id", value: { id } }),
        recover: () =>
          Promise.resolve({
            state: "pending",
            progress: { phase: "reconciling", code: "checking-outcome" },
          }),
      },
      handler: async (ctx, p) => {
        const run = async () => {
          calls.push(`effect:${p.title}`);
          if (p.title === "first") {
            entered.resolve();
            if (heldClass === "native") await held.promise;
            else {
              const nested = async () =>
                await ctx.execution!.wait!(held.promise);
              await ctx.execution!.wait!(nested());
            }
          }
          calls.push(`settled:${p.title}`);
          return p.title;
        };
        if (heldClass === "native") {
          return await nativeEffect(ctx, run, completion);
        }
        const result = await run();
        return ctx.execution!.local(
          () => result,
          (id) => ({ kind: "example-id", value: { id } }),
        );
      },
    });
    registry.register("requests.local", {
      params: (p) => ({ title: String(p.title) }),
      execution: {
        kind: "local",
        scope,
        receipt: (id) => ({ kind: "example-id", value: { id } }),
        recover: (_ctx, record) =>
          Promise.resolve({
            state: "complete",
            result: JSON.parse(record.receipt_json!).id,
          }),
      },
      handler: (ctx, p) =>
        ctx.execution!.local(() => {
          calls.push(`local:${p.title}`);
          return p.title;
        }, (id) => ({ kind: "example-id", value: { id } })),
    });
    registry.register("requests.observe", {
      params: (p) => ({ title: String(p.title) }),
      execution: {
        kind: "read",
        scope,
        receipt: () => undefined,
        recover: () => Promise.resolve({ state: "reload" }),
      },
      handler: (_ctx, p) => p.title,
    });
    const coordinator = new RequestCoordinator({
      registry,
      receipts: new Requests(db),
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
      send(event: RequestEvent) {
        events.push(event);
        if (
          event.t === "request.result" && event.outcome.ok &&
          event.outcome.result === "barrier"
        ) observed.resolve();
      },
      lease: { id: "yield", signal: new AbortController().signal, defer() {} },
    };
    const admit = (
      method: "requests.example" | "requests.local" | "requests.observe",
      title: string,
    ) =>
      coordinator.accept("local", {
        t: "request",
        method,
        params: { title },
        ref: {
          id: crypto.randomUUID(),
          clientID: crypto.randomUUID(),
          key: crypto.randomUUID(),
          window: coordinator.window().id,
        },
      }, recipient);
    try {
      await admit("requests.example", "first");
      await entered.promise;
      await admit("requests.example", "second");
      await admit("requests.local", "one");
      await admit("requests.local", "two");
      await admit("requests.observe", "barrier");
      await observed.promise;
      assertEquals(calls, ["effect:first", "local:one", "local:two"]);
      assertEquals(
        events.some((event) =>
          event.t === "request.progress" &&
          event.ref.key === events[0].ref.key &&
          event.progress.phase === "waiting" &&
          event.progress.code === "working"
        ),
        true,
        "Readiness alone must not replace action-specific pending feedback with backend-unavailable",
      );
      assertEquals(events.filter((e) => e.t === "request.result").length, 3);
      held.resolve();
      await coordinator.idle();
      assertEquals(calls, [
        "effect:first",
        "local:one",
        "local:two",
        "settled:first",
        "effect:second",
        "settled:second",
      ]);
    } finally {
      held.resolve();
      await coordinator.stop();
      db.close();
    }
  });
}

for (const ending of ["resume", "stop"] as const) {
  test(`a ready metadata continuation re-queues behind active work and ${ending} joins its ownership`, async () => {
    const db = new OtkDb(await fixture(), [requestsMigrations], {
      busyms: 5000,
    });
    const ready = Promise.withResolvers<void>();
    const validating = Promise.withResolvers<void>();
    const active = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const calls: string[] = [];
    let cancelled = false;
    const harness = {
      core: {
        identities: async (ids: readonly string[], signal?: AbortSignal) => {
          validating.resolve();
          const cancel = () => {
            cancelled = true;
            ready.reject(signal!.reason);
          };
          signal?.addEventListener("abort", cancel, { once: true });
          try {
            await ready.promise;
            return ids.map((id) => ({ id, directory: "/p" }));
          } finally {
            signal?.removeEventListener("abort", cancel);
          }
        },
      },
    } as unknown as Harness;
    const registry = new RpcRegistry(harness, db);
    const scope = () => ({ sessionID: "tstv1-continuation" });
    const receipt = (id: string) => ({
      kind: "example-id" as const,
      value: { id },
    });
    registry.register("requests.example", {
      params: (p) => ({ title: String(p.title) }),
      execution: {
        kind: "prepared-local",
        scope,
        receipt,
        recover: (_ctx, record) =>
          Promise.resolve({
            state: "complete",
            result: JSON.parse(record.receipt_json!).id,
          }),
      },
      handler: async (ctx, p) => {
        await ctx.sessionDirectory("tstv1-continuation");
        return ctx.execution!.local(() => {
          calls.push("metadata");
          return p.title;
        }, receipt);
      },
    });
    registry.register("requests.local", {
      params: (p) => ({ title: String(p.title) }),
      execution: {
        kind: "native",
        scope,
        receipt,
        recover: () =>
          Promise.resolve({
            state: "pending",
            progress: { phase: "reconciling", code: "checking-outcome" },
          }),
      },
      handler: async (ctx, p) => {
        await ctx.execution!.beforeEffect();
        calls.push("critical:start");
        active.resolve();
        // A non-yielding critical section models work that must retain its turn.
        await release.promise;
        calls.push("critical:end");
        return p.title;
      },
    });
    registry.register("requests.barrier", {
      params: (p) => ({ title: String(p.title) }),
      execution: {
        kind: "read",
        scope,
        receipt: () => undefined,
        recover: () => Promise.resolve({ state: "reload" }),
      },
      handler: (_ctx, p) => p.title,
    });
    const coordinator = new RequestCoordinator({
      registry,
      receipts: new Requests(db),
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
    const recipient = {
      send(event: RequestEvent) {
        if (
          event.t === "request.result" && event.outcome.ok &&
          event.outcome.result === "barrier"
        ) observed.resolve();
      },
      lease: {
        id: "continuation",
        signal: new AbortController().signal,
        defer() {},
      },
    };
    const admit = (
      method: "requests.example" | "requests.local" | "requests.barrier",
      title: string,
    ) =>
      coordinator.accept("local", {
        t: "request",
        method,
        params: { title },
        ref: {
          id: crypto.randomUUID(),
          clientID: crypto.randomUUID(),
          key: crypto.randomUUID(),
          window: coordinator.window().id,
        },
      }, recipient);
    try {
      await admit("requests.example", "metadata");
      await validating.promise;
      await admit("requests.local", "native");
      await active.promise;
      if (ending === "resume") ready.resolve();
      await admit("requests.barrier", "barrier");
      await observed.promise;
      assertEquals(calls, ["critical:start"]);
      const stopped = ending === "stop" ? coordinator.stop() : undefined;
      release.resolve();
      await (stopped ?? coordinator.idle());
      assertEquals(cancelled, ending === "stop");
      assertEquals(
        calls,
        ending === "resume"
          ? ["critical:start", "critical:end", "metadata"]
          : ["critical:start", "critical:end"],
      );
    } finally {
      ready.resolve();
      release.resolve();
      await coordinator.stop();
      db.close();
    }
  });
}

test("strictly local registration rejects native identity preparation before invoking its provider", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations], { busyms: 5000 });
  let lookups = 0;
  const harness = {
    core: {
      identities: () => {
        lookups++;
        return Promise.resolve([]);
      },
    },
  } as unknown as Harness;
  const registry = new RpcRegistry(harness, db);
  registry.register("requests.local", {
    params: (p) => ({ title: String(p.title) }),
    execution: {
      kind: "local",
      scope: () => ({}),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "complete", result: "unused" }),
    },
    handler: (ctx) => ctx.sessionDirectory("tstv1-local"),
  });
  try {
    await assertRejects(
      () => registry.dispatch("requests.local", { title: "invalid" }),
      Error,
      "Local execution cannot resolve native identities",
    );
    assertEquals(lookups, 0);
  } finally {
    db.close();
  }
});
