// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { OtkDb } from "@otk/store";
import type { Harness } from "@otk/harness";
import { HttpRequestAdapter, RpcRegistry } from "../../../core/mod.ts";
import { test } from "../../support/resources.ts";
import { fixture } from "./support.ts";

declare module "@otk/protocol" {
  interface RpcMethods {
    "bootstrap.example": { params: { input: string }; result: { ok: boolean } };
  }
}
test("HTTP service uses shared coordinator, receipt-scoped event delivery and no durable credential rows", async () => {
  const db = new OtkDb(await fixture(), [], { busyms: 5000 });
  const registry = new RpcRegistry({} as Harness, db);
  let calls = 0;
  registry.register("bootstrap.example", {
    params: (p) => ({ input: String(p.input) }),
    execution: {
      kind: "read",
      scope: () => ({}),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "reload" }),
    },
    handler: () => {
      calls++;
      return { ok: true };
    },
  });
  const adapter = new HttpRequestAdapter({
    registry,
    policy: {
      windowms: 10000,
      retentionms: 10000,
      maxpending: 4,
      inputbytes: 10000,
      resultbytes: 10000,
      resumebatch: 4,
      sweepbatch: 4,
      livenessms: 1000,
      stoppingms: 1000,
    },
  });
  await adapter.start();
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: "bootstrap",
  };
  const secret = "a".repeat(64), origin = "https://consumer";
  try {
    const response = await adapter.admit(
      "bootstrap.example",
      ref,
      { input: "credential-not-persisted" },
      secret,
      origin,
    );
    assertEquals(response.status, 202);
    assertEquals((await response.json()).t, "request.accepted");
    assertEquals(calls, 0);
    assertEquals(
      (await adapter.events(ref, 0, "b".repeat(64), origin)).status,
      403,
    );
    assertEquals(
      (await adapter.events(ref, 0, secret, "https://other")).status,
      403,
    );
    const stream = await adapter.events(ref, 0, secret, origin);
    const events = (await stream.text()).trim().split("\n").map((line) =>
      JSON.parse(line)
    );
    assertEquals(events.at(-1).outcome, { ok: true, result: { ok: true } });
    assertEquals(calls, 1);
    assertEquals(
      db.connection.prepare(
        "SELECT name FROM sqlite_master WHERE name='request_receipts'",
      ).get(),
      undefined,
    );
  } finally {
    await adapter.stop();
    db.close();
  }
});

test("bootstrap admission remains available after its initial discovery window", async () => {
  const db = new OtkDb(await fixture(), [], { busyms: 5000 }),
    registry = new RpcRegistry({} as Harness, db);
  let now = 1;
  registry.register("bootstrap.example", {
    params: () => ({ input: "" }),
    execution: {
      kind: "read",
      scope: () => ({}),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "reload" }),
    },
    handler: () => ({ ok: true }),
  });
  const adapter = new HttpRequestAdapter({
    registry,
    clock: () => now,
    policy: {
      windowms: 10,
      retentionms: 10,
      maxpending: 4,
      inputbytes: 1000,
      resultbytes: 1000,
      resumebatch: 4,
      sweepbatch: 4,
      livenessms: 1000,
      stoppingms: 1000,
    },
  });
  await adapter.start();
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: "bootstrap",
  };
  try {
    now = 100;
    assertEquals(
      (await adapter.admit(
        "bootstrap.example",
        ref,
        { input: "first new login" },
        "a".repeat(64),
        "consumer",
      )).status,
      202,
    );
    await adapter.coordinator.idle();
  } finally {
    await adapter.stop();
    db.close();
  }
});
