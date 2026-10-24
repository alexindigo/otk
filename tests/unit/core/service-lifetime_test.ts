// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Harness } from "@otk/harness";
import { OtkDb, Prefs, prefsMigrations } from "@otk/store";
import {
  IndexStore,
  prefsOptions,
  RpcRegistry,
  startCore,
} from "../../../core/mod.ts";
import { test } from "../../support/resources.ts";
import { cfg, fixture } from "./support.ts";

for (
  const failure of ["auth", "backend", "listen", "stop", "source"] as const
) {
  test(`service lifetime attempts all cleanup after ${failure} failure`, async () => {
    const root = await fixture(), settings = cfg();
    settings.state.path = root;
    settings.server.port = 0;
    settings.auth.type = "none";
    if (failure === "auth") settings.auth.type = "invalid" as never;
    const stops: string[] = [];
    const backend: Harness = {
      capabilities: {},
      core: {
        kind: "test",
        version: "1",
        start: () =>
          failure === "backend"
            ? Promise.reject(new Error("start failed"))
            : Promise.resolve(),
        stop() {
          stops.push("backend");
          return failure === "stop"
            ? Promise.reject(new Error("stop failed"))
            : Promise.resolve();
        },
        subscriptions() {},
        getSession: () => Promise.reject(new Error("unused")),
        listChildren: () => Promise.resolve([]),
        listMessages: () => Promise.resolve([]),
        createSession: () => Promise.reject(new Error("unused")),
      },
    };
    const store = new OtkDb(root, [prefsMigrations]),
      prefs = new Prefs(store, prefsOptions),
      index = new IndexStore();
    let listeners = 0;
    const listen = index.listen.bind(index);
    index.listen = (listener) => {
      listeners++;
      const release = listen(listener);
      return () => {
        listeners--;
        release();
      };
    };
    const source = {
      snapshot: () => ({ t: "resync", sessionIDs: "all" } as const),
      listen: () => () => {
        stops.push("listener");
      },
      close: () => {
        stops.push("source");
        if (failure === "source") throw new Error("source cleanup failed");
      },
    };
    const occupied = failure === "listen"
      ? Deno.listen({ hostname: "127.0.0.1", port: 0 })
      : undefined;
    if (occupied) settings.server.port = (occupied.addr as Deno.NetAddr).port;
    let service: Awaited<ReturnType<typeof startCore>> | undefined;
    try {
      const starting = startCore({
        cfg: settings,
        backend,
        store,
        prefs,
        rpc: new RpcRegistry(backend, store),
        staticRoot: root,
        index,
        sources: [source],
      });
      if (failure !== "stop" && failure !== "source") {
        await assertRejects(() => starting);
      } else {
        service = await starting;
        const first = service.stop(), second = service.stop();
        await Promise.all([
          assertRejects(() => first, AggregateError),
          assertRejects(() => second, AggregateError),
        ]);
        assertEquals(stops.filter((value) => value === "backend").length, 1);
        const response = await fetch(
          `http://127.0.0.1:${service.server.addr.port}/api/health`,
        ).catch(() => undefined);
        if (response) await response.body?.cancel();
        assertEquals(
          response,
          undefined,
          "HTTP listener survived backend stop failure",
        );
      }
      assert(stops.includes("source"), "Feature lifetime was not released");
      assertEquals(listeners, 0, "Index subscription survived teardown");
      assertThrows(() => prefs.get(), Error);
    } finally {
      occupied?.close();
      await service?.server.shutdown();
      service?.connections.close();
      if (store.connection.isOpen) store.close();
    }
  });
}
