// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { cfg } from "../../../tests/support/config.ts";
import { resources, tempDir, test } from "../../../tests/support/resources.ts";
import { waitFor } from "../../../tests/support/opencode.ts";
import { OpencodeV1Adapter } from "../adapter.ts";

test("native bootstrap completion is distinct from versioned connection invalidation", async () => {
  const config = cfg();
  config.harness.db = (await tempDir("authority-")) + "/absent.db";
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let disconnect!: () => void;
  const send = (type: string) =>
    stream.enqueue(new TextEncoder().encode(
      `data: ${
        JSON.stringify({ directory: "/p", payload: { type, properties: {} } })
      }\n\n`,
    ));
  const fetcher: typeof fetch = (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/global/health") {
      return Promise.resolve(Response.json({ version: "1.18.34" }));
    }
    if (path === "/global/event") {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
              let closed = false;
              disconnect = () => {
                if (!closed) controller.close();
                closed = true;
              };
              send("server.connected");
              options?.signal?.addEventListener(
                "abort",
                disconnect,
                { once: true },
              );
            },
          }),
        ),
      );
    }
    assertEquals(path, "/experimental/session");
    return Promise.resolve(Response.json([]));
  };
  const adapter = new OpencodeV1Adapter(config, undefined, fetcher);
  resources().defer("authority adapter", () => adapter.core.stop());
  const events: { kind: string; value?: unknown }[] = [];
  const sink = {
    connection: (state: string) => events.push({ kind: state }),
    indexReset() {},
    indexUpsert() {},
    indexRemove() {},
    content() {},
    resync: () => events.push({ kind: "legacy" }),
    bootstrapComplete: () => events.push({ kind: "bootstrap" }),
    invalidate: (value: unknown) => events.push({ kind: "invalidated", value }),
  };
  await adapter.core.start(sink);
  await waitFor(() => events.some((e) => e.kind === "connected"), Boolean);
  assertEquals(events.filter((e) => e.kind === "bootstrap").length, 1);
  const before = events.filter((e) => e.kind === "invalidated");
  assertEquals(before.length, 1);
  assert(
    events.indexOf(before[0]) < events.findIndex((e) => e.kind === "bootstrap"),
  );
  send("server.instance.disposed");
  await waitFor(
    () => events.filter((e) => e.kind === "bootstrap").length,
    (n) => n === 2,
  );
  const versions = events.filter((e) => e.kind === "invalidated").map((e) =>
    e.value as { version: { generation: number } }
  );
  assertEquals(versions.length, 2);
  assert(versions[1].version.generation > versions[0].version.generation);
  disconnect();
  await waitFor(
    () => events.filter((e) => e.kind === "bootstrap").length,
    (n) => n === 3,
  );
  const reconnected = events.filter((e) => e.kind === "invalidated").at(-1)!
    .value as { version: { generation: number } };
  assert(reconnected.version.generation > versions[1].version.generation);
  assertEquals(events.filter((e) => e.kind === "legacy"), []);
});
