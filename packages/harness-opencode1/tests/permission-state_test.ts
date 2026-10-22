// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../../tests/support/resources.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ContentOp } from "@otk/protocol";
import { Opencode1Adapter } from "../adapter.ts";
import { StreamBuffers } from "@otk/content";
import { cfg, fixture } from "../../../tests/support/config.ts";
import { waitFor } from "../../../tests/support/opencode.ts";

test("native pending permission events own normalized family reads and removal without a second live HTTP list", async () => {
  const settings = cfg();
  settings.harness.db = join(await fixture(), "missing.db");
  const root = {
    id: "root",
    directory: "/project",
    projectID: "p",
    title: "Root",
    time: { created: 1, updated: 1 },
  };
  let stream!: ReadableStreamDefaultController<Uint8Array>,
    connected = false,
    reads = 0;
  const fetcher: typeof fetch = (input, options) => {
    const url = new URL(String(input)), path = url.pathname;
    if (path === "/permission/request/reply") {
      assertEquals(url.searchParams.get("directory"), "/asking-instance");
      return Promise.resolve(Response.json(true));
    }
    if (path === "/global/health") {
      return Promise.resolve(Response.json({ version: "1.18.34" }));
    }
    if (path === "/experimental/session") {
      return Promise.resolve(
        Response.json([root, { ...root, id: "child", parentID: "root" }, {
          ...root,
          id: "other",
        }]),
      );
    }
    if (path === "/permission") {
      reads++;
      if (reads === 1) return Promise.resolve(Response.json([]));
      return Promise.resolve(
        new Response(
          "Expected JSON value, got undefined at metadata.livecrawl",
          { status: 400 },
        ),
      );
    }
    if (path === "/session/status") {
      return Promise.resolve(Response.json({}));
    }
    if (path === "/question") {
      return Promise.resolve(Response.json([]));
    }
    assertEquals(path, "/global/event");
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"directory":"/project","payload":{"type":"server.connected","properties":{}}}\n\n',
              ),
            );
            options?.signal?.addEventListener(
              "abort",
              () => controller.close(),
              { once: true },
            );
          },
        }),
      ),
    );
  };
  const adapter = new Opencode1Adapter(settings, new StreamBuffers(), fetcher),
    ops: ContentOp[] = [];
  const emit = (type: string, properties: Record<string, unknown>) =>
    stream.enqueue(
      new TextEncoder().encode(
        `data: ${
          JSON.stringify({
            directory: "/asking-instance",
            payload: { type, properties },
          })
        }\n\n`,
      ),
    );
  try {
    await adapter.core.start({
      connection: (state) => {
        connected = state === "connected";
      },
      indexReset() {},
      indexUpsert() {},
      indexRemove() {},
      content: (_id, op) => ops.push(op),
      resync() {},
    });
    await waitFor(() => connected, Boolean);
    emit("permission.asked", {
      id: "request",
      sessionID: "child",
      permission: "websearch",
      patterns: ["exact query"],
      always: ["*"],
      metadata: { query: "exact query", livecrawl: undefined },
      tool: { callID: "call-web", messageID: "message" },
    });
    await waitFor(
      () => ops.some((op) => op.op === "permission.upsert"),
      Boolean,
    );
    const port = adapter.capabilities.permissions!;
    const parent = await port.listPermissions("root");
    assertEquals(parent.length, 1);
    assertEquals(parent[0].detail, { kind: "generic", summary: "exact query" });
    assertEquals(parent[0].toolCall, "call-web");
    assertEquals(await port.listPermissions("child"), parent);
    assertEquals(await port.listPermissions("other"), []);
    parent[0].patterns[0] = "consumer mutation";
    assertEquals((await port.listPermissions("root"))[0].patterns, [
      "exact query",
    ]);
    assertEquals(
      reads,
      1,
      "Family reads must not repeat the bootstrap inventory",
    );
    await port.replyPermission({
      sessionID: "child",
      requestID: "request",
      reply: "once",
    });
    emit("permission.replied", {
      requestID: "request",
      sessionID: "child",
      reply: "reject",
    });
    await waitFor(
      () => ops.some((op) => op.op === "permission.remove"),
      Boolean,
    );
    assertEquals(await port.listPermissions("root"), []);
  } finally {
    await adapter.core.stop();
  }
});
