// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { HttpRequests } from "@otk/client";
import type { Harness } from "@otk/harness";
import { OtkDb } from "@otk/store";
import { HttpRequestAdapter, RpcRegistry } from "../../core/mod.ts";
import { serve } from "../support/http.ts";
import { tempDir, test } from "../support/resources.ts";

declare module "@otk/protocol" {
  interface RpcMethods {
    "http.proof": { params: { username: string }; result: { ok: true } };
  }
}
test("independent HTTP composition holds cookie headers until result and consumer sees exactly one outcome", async () => {
  const db = new OtkDb(await tempDir("http-requests-"), [], { busyms: 5000 }),
    registry = new RpcRegistry({} as Harness, db);
  const held = Promise.withResolvers<void>();
  let effects = 0;
  registry.register("http.proof", {
    params: (input) => ({ username: String(input.username) }),
    execution: {
      kind: "read",
      scope: () => ({}),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "reload" }),
    },
    handler: async () => {
      effects++;
      await held.promise;
      return { ok: true as const };
    },
  });
  const adapter = new HttpRequestAdapter({
    registry,
    policy: {
      windowms: 10000,
      retentionms: 10000,
      maxpending: 8,
      inputbytes: 10000,
      resultbytes: 1000,
      resumebatch: 8,
      sweepbatch: 8,
      livenessms: 5,
      stoppingms: 5,
    },
    resultHeaders: () => ({ "Set-Cookie": "proof=accepted; HttpOnly; Path=/" }),
  });
  await adapter.start();
  const observed: { status: number; cookie: string | null; path: string }[] =
    [];
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      const secret = request.headers.get("X-OTK-Receipt") ?? "";
      return path.endsWith("request-events")
        ? adapter.events(body.ref, body.after, secret, "consumer")
        : adapter.admit("http.proof", body.ref, body.input, secret, "consumer");
    },
  );
  const http = new HttpRequests({
    base: new URL(`http://127.0.0.1:${server.addr.port}/api/`),
    fetcher: async (url, options) => {
      const response = await fetch(url, options);
      observed.push({
        status: response.status,
        cookie: response.headers.get("Set-Cookie"),
        path: String(url),
      });
      return response;
    },
  });
  try {
    const operation = http.start<{ ok: true }>("login", {
      username: "consumer",
      password: "fixture-secret",
    });
    // Server execution can precede receipt of the admission response by the client.
    const admissionDeadline = performance.now() + 2000;
    while (
      operation.state.phase !== "queued" &&
      performance.now() < admissionDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assertEquals(operation.state.phase, "queued");
    assertEquals(observed.length, 1);
    assertEquals(observed[0].status, 202);
    assertEquals(observed[0].cookie, null);
    held.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assertEquals(
        await Promise.race([
          operation.result,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("HTTP result did not reach its consumer")),
              2000,
            );
          }),
        ]),
        { ok: true },
      );
    } finally {
      clearTimeout(timer);
    }
    assertEquals(effects, 1);
    assertEquals(observed[1].cookie, "proof=accepted; HttpOnly; Path=/");
  } finally {
    held.resolve();
    await http.stop();
    await adapter.stop();
    await server.shutdown();
    db.close();
  }
});
