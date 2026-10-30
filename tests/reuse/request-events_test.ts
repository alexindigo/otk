// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { RequestTracker, Rpc } from "@otk/client";
import type { Harness } from "@otk/harness";
import {
  OtkDb,
  Requests,
  requestsMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { RequestCoordinator, RpcRegistry } from "../../core/mod.ts";
import { tempDir, test } from "../support/resources.ts";

declare module "@otk/protocol" {
  interface RpcMethods {
    "consumer.create": { params: { name: string }; result: string };
  }
  interface RequestReceipts {
    "consumer-task": { id: string };
  }
}
test("independent typed client and external registration observe one captured local effect through result events", async () => {
  const db = new OtkDb(await tempDir("request-consumer-"), [
    requestsMigrations,
    tasksMigrations,
  ]);
  const tasks = new Tasks(db), registry = new RpcRegistry({} as Harness, db);
  let effects = 0;
  registry.register("consumer.create", {
    params: (value) => {
      if (typeof value.name !== "string") throw new TypeError("name required");
      return { name: value.name };
    },
    execution: {
      kind: "local",
      scope: () => ({ directory: "/consumer" }),
      receipt: (id) => ({ kind: "consumer-task", value: { id } }),
      recover: (_ctx, record) =>
        Promise.resolve({
          state: "complete",
          result: JSON.parse(record.receipt_json!).id,
        }),
    },
    handler: (ctx, input) =>
      ctx.execution!.local((tx) => {
        effects++;
        return tasks.create("/consumer", input.name, [], tx).id;
      }, (id) => ({ kind: "consumer-task", value: { id } })),
  });
  const coordinator = new RequestCoordinator({
    registry,
    receipts: new Requests(db),
    policy: {
      windowms: 10000,
      retentionms: 10000,
      maxpending: 8,
      inputbytes: 10000,
      resultbytes: 1000,
      resumebatch: 8,
      sweepbatch: 8,
      livenessms: 1000,
      stoppingms: 1000,
    },
  });
  await coordinator.start();
  const recipient = {
    send: (event: Parameters<RequestTracker["receive"]>[0]) =>
      tracker.receive(event),
    lease: { id: "consumer", signal: new AbortController().signal, defer() {} },
  };
  const deliveries: Promise<void>[] = [];
  const tracker = new RequestTracker({
    send: (frame) => {
      deliveries.push(coordinator.accept("consumer", frame, recipient));
    },
  });
  tracker.connect(coordinator.window(), 8);
  const rpc = new Rpc(() => {
    throw new Error("Legacy transport must not run");
  }, tracker);
  try {
    const operation = rpc.start("consumer.create", { name: "perf" }, {
      owner: "project",
    });
    assertEquals(
      rpc.start("consumer.create", { name: "perf" }, {
        intent: operation.state.ref,
      }),
      operation,
    );
    await Promise.all(deliveries);
    await coordinator.idle();
    const id: string = await operation.result;
    assertEquals(effects, 1);
    assertEquals(tasks.get(id).name, "perf");
    assertEquals(tasks.list("/consumer").length, 1);
  } finally {
    tracker.stop();
    await coordinator.stop();
    db.close();
  }
});
