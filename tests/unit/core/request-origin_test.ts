// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { OtkDb, Requests, requestsMigrations } from "@otk/store";
import {
  OperationFailure,
  type RequestEvent,
  type RequestOrigin,
} from "@otk/protocol";
import type { Harness } from "@otk/harness";
import { RequestCoordinator, RpcRegistry } from "../../../core/mod.ts";
import { test } from "../../support/resources.ts";
import { fixture } from "./support.ts";

declare module "@otk/protocol" {
  interface RpcMethods {
    "origin.fail": { params: Record<string, never>; result: null };
    "origin.lease": { params: Record<string, never>; result: null };
  }
}
test("request origin reaches execution and retained failure, survives restart and cannot change on replay", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations], { busyms: 5000 });
  const receipts = new Requests(db),
    registry = new RpcRegistry({} as Harness, db);
  let observed: RequestOrigin | undefined;
  registry.register("origin.fail", {
    params: () => ({}),
    execution: {
      kind: "native",
      scope: () => ({ sessionID: "tstv1-origin" }),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "reload" }),
    },
    handler(ctx) {
      observed = ctx.execution?.key.origin;
      throw new OperationFailure(
        "rejected",
        "native.rejected",
        new Error("fixture"),
        { reason: "Rejected input" },
      );
    },
  });
  const options = {
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
  };
  let coordinator = new RequestCoordinator(options);
  const events: RequestEvent[] = [];
  const recipient = {
    send: (event: RequestEvent) => events.push(event),
    lease: { id: "origin", signal: new AbortController().signal, defer() {} },
  };
  try {
    await coordinator.start();
    for (const origin of [undefined, "composer", "palette", "api"] as const) {
      const ref = {
        id: crypto.randomUUID(),
        clientID: crypto.randomUUID(),
        key: crypto.randomUUID(),
        window: coordinator.window().id,
        ...(origin ? { origin } : {}),
      };
      await coordinator.accept("local", {
        t: "request",
        ref,
        method: "origin.fail",
        params: {},
      }, recipient);
      await coordinator.idle();
      assertEquals(observed, origin);
      assertEquals(
        receipts.get({
          principal: "local",
          client_id: ref.clientID,
          intent_key: ref.key,
        })?.origin,
        origin ?? null,
      );
      const event = events.at(-1)!;
      assertEquals(event.t, "request.result");
      if (event.t === "request.result" && !event.outcome.ok) {
        assertEquals(event.outcome.error.facts?.origin, origin);
      }
      await coordinator.stop();
      coordinator = new RequestCoordinator(options);
      await coordinator.start();
      await coordinator.accept("local", {
        t: "request.resume",
        items: [{ ref, after: 0 }],
      }, recipient);
      const replay = events.at(-1)!;
      if (replay.t === "request.result" && !replay.outcome.ok) {
        assertEquals(replay.outcome.error.facts?.origin, origin);
      } else throw new Error("Missing retained failure replay");
      await coordinator.accept("local", {
        t: "request",
        ref: { ...ref, origin: origin === "composer" ? "api" : "composer" },
        method: "origin.fail",
        params: {},
      }, recipient);
      assertEquals(events.at(-1)?.t, "request.rejected");
      await coordinator.accept("local", {
        t: "request.resume",
        items: [{
          ref: { ...ref, origin: origin === "composer" ? "api" : "composer" },
          after: 0,
        }],
      }, recipient);
      assertEquals(events.at(-1)?.t, "request.rejected");
    }
  } finally {
    await coordinator.stop();
    db.close();
  }
});

for (const expired of [false, true]) {
  test(`a wrong-origin release cannot abort a request lease or run its cleanup: expired=${expired}`, async () => {
    const db = new OtkDb(await fixture(), [requestsMigrations], {
      busyms: 5000,
    });
    const receipts = new Requests(db),
      registry = new RpcRegistry({} as Harness, db);
    let signal: AbortSignal | undefined, cleaned = 0;
    registry.register("origin.lease", {
      params: () => ({}),
      execution: {
        kind: "lease",
        lifetime: "request",
        scope: () => ({}),
        receipt: () => undefined,
        recover: () => Promise.resolve({ state: "reload" }),
      },
      handler(ctx) {
        signal = ctx.request!.signal;
        ctx.request!.defer(() => {
          cleaned++;
        });
        return null;
      },
    });
    let now = Date.now();
    const coordinator = new RequestCoordinator({
      registry,
      receipts,
      clock: () => now,
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
    const events: RequestEvent[] = [],
      recipient = {
        send: (e: RequestEvent) => events.push(e),
        lease: {
          id: "origin-release",
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
        origin: "composer" as const,
      };
      await coordinator.accept("local", {
        t: "request",
        ref,
        method: "origin.lease",
        params: {},
      }, recipient);
      await coordinator.idle();
      assert(signal);
      assertEquals(signal.aborted, false);
      assertEquals(cleaned, 0);
      if (expired) {
        now += 60000;
        coordinator.maintenance();
        assertEquals(
          receipts.get({
            principal: "local",
            client_id: ref.clientID,
            intent_key: ref.key,
          }),
          undefined,
        );
      }
      for (
        const mismatch of [{ ...ref, origin: "api" as const }, {
          ...ref,
          window: crypto.randomUUID(),
        }]
      ) {
        const delivered = events.length;
        await coordinator.accept("local", {
          t: "request.release",
          refs: [mismatch],
        }, recipient);
        assertEquals(
          events.length,
          delivered,
          "Release controls retain their silent rejection contract",
        );
        assertEquals(
          signal.aborted,
          false,
          "Rejected control must not change request lifetime",
        );
        assertEquals(cleaned, 0);
      }
      await coordinator.accept(
        "local",
        { t: "request.release", refs: [ref] },
        recipient,
      );
      assertEquals(signal.aborted, true);
      assertEquals(cleaned, 1);
      await coordinator.accept(
        "local",
        { t: "request.release", refs: [ref] },
        recipient,
      );
      assertEquals(cleaned, 1, "A released lifetime is retired exactly once");
    } finally {
      await coordinator.stop();
      db.close();
    }
  });
}
