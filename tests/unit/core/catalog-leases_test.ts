// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Harness } from "@otk/harness";
import { OtkDb, Requests, requestsMigrations } from "@otk/store";
import { RpcRegistry } from "../../../core/ws/registry.ts";
import { RequestCoordinator } from "../../../core/requests/coordinator.ts";
import { registerCatalogs } from "../../../core/features/catalogs.ts";
import {
  createCatalogCodecs,
  type RequestEvent,
  type ServerFrame,
} from "@otk/protocol";
import { cfg, fixture } from "./support.ts";
import { test } from "../../support/resources.ts";
test("a settled catalog lease releases after result receipt without closing its socket", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations]);
  let released = 0;
  const backend = {
    capabilities: {
      catalogs: {
        watch: (directory: string, _listener: unknown, signal: AbortSignal) => {
          signal.addEventListener("abort", () => {
            released++;
          }, { once: true });
          return Promise.resolve({
            directory,
            generation: "g",
            revision: 0,
            paths: { style: "posix", separator: "/" },
            values: {},
          });
        },
        refresh: () => Promise.resolve(),
      },
    },
  } as unknown as Harness;
  const rpc = new RpcRegistry(backend, db);
  registerCatalogs(rpc, backend, createCatalogCodecs(), 1);
  const coordinator = new RequestCoordinator({
    registry: rpc,
    receipts: new Requests(db),
    policy: cfg().requests,
  });
  await coordinator.start();
  const events: RequestEvent[] = [],
    frames: ServerFrame[] = [],
    callbacks = new Set<() => void>();
  const recipient = {
    send: (event: RequestEvent) => {
      events.push(event);
    },
    lease: {
      id: "socket",
      signal: new AbortController().signal,
      publish: (frame: ServerFrame) => {
        frames.push(frame);
      },
      defer: (release: () => void) => {
        callbacks.add(release);
        return () => {
          callbacks.delete(release);
        };
      },
    },
  };
  const ref = {
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    id: crypto.randomUUID(),
    window: coordinator.window().id,
  };
  try {
    await coordinator.accept("local", {
      t: "request",
      ref,
      method: "catalogs.watch",
      params: { directory: "/p" },
    }, recipient);
    await coordinator.idle();
    const result = events.findLast((event) => event.t === "request.result")!;
    assertEquals(result.t, "request.result");
    if (!("seq" in result)) throw new Error("Missing result sequence");
    await coordinator.accept("local", {
      t: "request.received",
      refs: [{ ref, seq: result.seq }],
    }, recipient);
    assertEquals(released, 0);
    await coordinator.accept(
      "local",
      { t: "request.release", refs: [ref] },
      recipient,
    );
    assertEquals(released, 1);
    assertEquals(callbacks.size, 0);
    await coordinator.accept(
      "local",
      { t: "request.release", refs: [ref] },
      recipient,
    );
    assertEquals(released, 1);
  } finally {
    await coordinator.stop();
    db.close();
  }
});
