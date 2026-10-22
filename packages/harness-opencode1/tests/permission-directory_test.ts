// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Client } from "../client.ts";
import { permissions } from "../permissions.ts";
import { cfg, fixture } from "../../../tests/support/config.ts";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { Opencode1Adapter } from "../adapter.ts";
import { waitFor } from "../../../tests/support/opencode.ts";

Deno.test("permission reply without pending instance resolves and always sends a directory", async () => {
  let resolved = 0;
  const client = new Client(
    { ...cfg().harness, url: "http://native" },
    (input) => {
      assertEquals(
        new URL(String(input)).searchParams.get("directory"),
        "/resolved",
      );
      return Promise.resolve(Response.json(true));
    },
  );
  const port = permissions(
    client,
    {
      cached: () => undefined,
      resolve: () => {
        resolved++;
        return Promise.resolve("/resolved");
      },
    },
    () => undefined,
    () => [],
  );
  await port.replyPermission({
    sessionID: "missing-index-row",
    requestID: "request",
    reply: "once",
  });
  assertEquals(resolved, 1);
});

Deno.test("bootstrap permission reply retains its listing instance even when session metadata names another directory", async () => {
  const settings = cfg(), path = join(await fixture(), "native.db");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE session(id TEXT, directory TEXT, time_updated INTEGER); CREATE TABLE message(id TEXT, session_id TEXT, data TEXT)",
  );
  db.prepare("INSERT INTO session VALUES(?,?,?)").run(
    "root",
    "/asking-bootstrap",
    Date.now(),
  );
  db.prepare("INSERT INTO message VALUES(?,?,?)").run(
    "message",
    "root",
    JSON.stringify({ role: "user" }),
  );
  db.close();
  settings.harness.db = path;
  let connected = false, replies = 0;
  const adapter = new Opencode1Adapter(
    settings,
    undefined,
    (input, options) => {
      const url = new URL(String(input));
      if (url.pathname === "/global/health") {
        return Promise.resolve(
          Response.json({ version: "1.18.34" }),
        );
      }
      if (url.pathname === "/experimental/session") {
        return Promise.resolve(
          Response.json([{
            id: "root",
            directory: "/metadata-directory",
            projectID: "p",
            title: "Root",
            time: { created: 1, updated: Date.now() },
          }]),
        );
      }
      if (url.pathname === "/permission") {
        if (url.searchParams.get("directory") === "/metadata-directory") {
          return Promise.resolve(Response.json([]));
        }
        assertEquals(url.searchParams.get("directory"), "/asking-bootstrap");
        return Promise.resolve(
          Response.json([{
            id: "ask",
            sessionID: "root",
            permission: "bash",
            patterns: ["printf exact"],
            always: [],
            metadata: { command: "printf exact" },
          }]),
        );
      }
      if (url.pathname === "/session/status") {
        return Promise.resolve(
          Response.json({}),
        );
      }
      if (url.pathname === "/question") {
        return Promise.resolve(
          Response.json([]),
        );
      }
      if (url.pathname === "/permission/ask/reply") {
        assertEquals(url.searchParams.get("directory"), "/asking-bootstrap");
        replies++;
        return Promise.resolve(Response.json(true));
      }
      assertEquals(url.pathname, "/global/event");
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"directory":"/asking-bootstrap","payload":{"type":"server.connected","properties":{}}}\n\n',
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
    },
  );
  try {
    await adapter.core.start({
      connection: (s) => {
        connected = s === "connected";
      },
      indexReset() {},
      indexUpsert() {},
      indexRemove() {},
      content() {},
      resync() {},
    });
    await waitFor(() => connected, Boolean);
    const port = adapter.capabilities.permissions!;
    assertEquals((await port.listPermissions("root")).length, 1);
    await port.replyPermission({
      sessionID: "root",
      requestID: "ask",
      reply: "once",
    });
    assertEquals(replies, 1);
  } finally {
    await adapter.core.stop();
  }
});
