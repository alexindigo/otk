// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { resources, test } from "../../../tests/support/resources.ts";
import { cfg } from "../../../tests/support/config.ts";
import { SessionIndex } from "@otk/harness";
import { Opencode1Adapter } from "../adapter.ts";
import type { Session } from "../types.ts";

test("explicit session deletion releases pending input and its attention without reply events", async () => {
  const root = await resources().tempDir("disposal-"), settings = cfg();
  settings.harness.db = root + "/missing.db";
  const index = new SessionIndex(), ready = Promise.withResolvers<void>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let barrier = Promise.withResolvers<void>();
  let marker = 0;
  const session = (id: string, parentID?: string): Session => ({
    id,
    parentID,
    directory: "/project",
    projectID: "p",
    title: id,
    time: { created: 1, updated: 2 },
  });
  const adapter = new Opencode1Adapter(settings, undefined, (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/global/health") {
      return Promise.resolve(Response.json({ version: "1" }));
    }
    if (path === "/experimental/session") {
      return Promise.resolve(
        Response.json([session("root"), session("child", "root")]),
      );
    }
    if (path === "/session/status") return Promise.resolve(Response.json({}));
    if (path === "/permission" || path === "/question" || path === "/agent") {
      return Promise.resolve(Response.json([]));
    }
    assertEquals(path, "/global/event");
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
            send("server.connected", {});
          },
        }),
      ),
    );
  });
  function send(type: string, properties: object) {
    stream.enqueue(
      new TextEncoder().encode(
        `data: ${
          JSON.stringify({
            directory: "/project",
            payload: { type, properties },
          })
        }\n\n`,
      ),
    );
  }
  async function drain() {
    barrier = Promise.withResolvers<void>();
    send("session.status", {
      sessionID: "root",
      status: { type: "retry", attempt: ++marker, message: "barrier", next: 1 },
    });
    await barrier.promise;
  }
  try {
    await adapter.core.start({
      index,
      connection() {},
      indexReset: (entries) => index.reset(entries),
      indexUpsert(entry) {
        index.upsert(entry);
        if (entry.id === "root" && entry.retry?.attempt === marker) {
          barrier.resolve();
        }
      },
      indexRemove: (id) => index.remove(id),
      content() {},
      resync: () => ready.resolve(),
    });
    await ready.promise;
    send("permission.asked", {
      id: "permission",
      sessionID: "child",
      permission: "bash",
      patterns: ["*"],
      always: [],
      metadata: {},
    });
    send("question.asked", {
      id: "question",
      sessionID: "child",
      questions: [],
    });
    await drain();
    assertEquals(index.get("root")?.attention.childPermissions, 1);
    send("session.deleted", { info: session("child", "root") });
    await drain();
    assertEquals(
      await adapter.capabilities.permissions!.listPermissions("child"),
      [],
      "Deleted session still owns a pending request",
    );
    send("session.created", { info: session("child", "root") });
    await drain();
    assertEquals(index.get("root")?.attention.childPermissions, 0);
    assertEquals(index.get("root")?.attention.childQuestions, 0);
    assertEquals(index.get("child")?.attention.permissions, 0);
    assertEquals(index.get("child")?.attention.questions, 0);
    assert(index.get("child"));
  } finally {
    await adapter.core.stop();
  }
});
