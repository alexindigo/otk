// SPDX-License-Identifier: LGPL-3.0-only
import { tempDir, test } from "../../../tests/support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type { ContentOp } from "@otk/protocol";
import type { IndexEntry } from "@otk/protocol";
import { loadServiceConfig } from "../../../core/config/loader.ts";
import { Opencode1Adapter } from "../adapter.ts";
import { StreamBuffers } from "@otk/content";
import type { Envelope } from "../types.ts";
import { cfg, fixture } from "../../../tests/support/config.ts";

test("adapter maps legacy event chain while ignoring its captured durable sync companion", async () => {
  const cfg = loadServiceConfig({
    defaultsPath: fromFileUrl(
      new URL("../../../defaults/otk.toml", import.meta.url),
    ),
    env: {},
  }).config;
  cfg.harness.db = join(await tempDir("native-events-"), "missing.db");
  const session = {
    id: "ses_fixture",
    projectID: "global",
    directory: "/project",
    title: "Streaming",
    time: { created: 1, updated: 1 },
  };
  const message = {
    id: "msg_fixture",
    sessionID: session.id,
    role: "assistant",
    agent: "build",
    providerID: "fake",
    modelID: "scripted",
    time: { created: 2, completed: 3 },
  };
  const sync = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../tests/fixtures/opencode1/sync-envelope.json",
        import.meta.url,
      ),
    ),
  );
  const event = (
    type: string,
    properties: Record<string, unknown>,
  ): Envelope => ({ directory: "/project", payload: { type, properties } });
  const frames = [
    event("server.connected", {}),
    event("session.created", { info: session }),
    sync,
    event("session.status", {
      sessionID: session.id,
      status: { type: "busy" },
    }),
    event("session.error", {
      sessionID: session.id,
      error: { name: "UnknownError", data: { message: "fixture error" } },
    }),
    event("permission.asked", {
      id: "per_fixture",
      sessionID: session.id,
      permission: "bash",
      patterns: ["echo otk"],
      always: ["echo *"],
      metadata: { command: "echo otk" },
    }),
    event("permission.replied", {
      requestID: "per_fixture",
      sessionID: session.id,
      reply: "once",
    }),
    event("question.asked", {
      id: "que_fixture",
      sessionID: session.id,
      questions: [{
        header: "Choice",
        question: "Choose",
        options: [{ label: "Yes" }],
      }],
    }),
    event("question.replied", {
      requestID: "que_fixture",
      sessionID: session.id,
    }),
    event("question.asked", {
      id: "que_second",
      sessionID: session.id,
      questions: [{
        header: "Choice",
        question: "Choose",
        options: [{ label: "Yes" }],
      }],
    }),
    event("question.rejected", {
      requestID: "que_second",
      sessionID: session.id,
    }),
    event("message.updated", { info: message }),
    event("message.part.updated", {
      part: {
        id: "prt_fixture",
        sessionID: session.id,
        messageID: message.id,
        type: "text",
        text: "# Fixture",
        time: { start: 2, end: 3 },
      },
    }),
    event("message.part.removed", {
      sessionID: session.id,
      messageID: message.id,
      partID: "prt_fixture",
    }),
    event("session.diff", {
      sessionID: session.id,
      diff: [{ file: "fixture.ts", additions: 1, deletions: 0 }],
    }),
    event("todo.updated", {
      sessionID: session.id,
      todos: [{ content: "fixture", status: "completed", priority: "medium" }],
    }),
    event("message.removed", { sessionID: session.id, messageID: message.id }),
    event("session.status", {
      sessionID: session.id,
      status: { type: "retry", attempt: 2, message: "retry", next: 4 },
    }),
    event("session.idle", { sessionID: session.id }),
    event("session.updated", { info: { ...session, title: "Updated" } }),
    event("session.deleted", { info: session }),
  ];
  let nativeReads = 0;
  const fetcher: typeof fetch = (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === "/global/health") {
      return Promise.resolve(Response.json({ version: "1.18.34" }));
    }
    if (url.pathname === "/experimental/session" || url.pathname === "/agent") {
      return Promise.resolve(Response.json([]));
    }
    if (url.pathname === `/session/${session.id}/message/${message.id}`) {
      nativeReads++;
      return Promise.resolve(
        Response.json({
          info: message,
          parts: frames.flatMap((frame) =>
            frame.payload.type === "message.part.updated"
              ? [frame.payload.properties!.part]
              : []
          ),
        }),
      );
    }
    assertEquals(url.pathname, "/global/event");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`),
          );
        }
        options?.signal?.addEventListener("abort", () => controller.close(), {
          once: true,
        });
      },
    });
    return Promise.resolve(new Response(stream));
  };
  const adapter = new Opencode1Adapter(cfg, new StreamBuffers(), fetcher);
  const ops: ContentOp[] = [], entries: IndexEntry[] = [];
  let removed = false, reconnects = 0;
  adapter.core.subscriptions(session.id, 1);
  try {
    await adapter.core.start({
      connection: (state) => {
        if (state === "reconnecting") reconnects++;
      },
      indexReset() {},
      indexUpsert: (entry) => entries.push(structuredClone(entry)),
      indexRemove: () => {
        removed = true;
      },
      content: (_id, op) => ops.push(op),
      resync() {},
    });
    const deadline = Date.now() + 2000;
    while (!removed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(removed, "Event chain stalled on sync companion");
    assertEquals(reconnects, 0);
    assertEquals(nativeReads, 1);
    const finished = ops.find((op) => op.op === "message.upsert");
    assert(
      finished?.op === "message.upsert" &&
        finished.message.role === "assistant",
    );
    assertEquals(finished.message.time.lastOutput, 3);
    assert(entries.some((entry) => entry.attention.permissions === 1));
    assert(entries.some((entry) => entry.attention.questions === 1));
    assert(
      entries.some((entry) =>
        entry.status === "retry" && entry.retry?.attempt === 2
      ),
    );
    assertEquals(ops.map((op) => op.op), [
      "session.error",
      "session.error",
      "permission.upsert",
      "permission.remove",
      "question.upsert",
      "question.remove",
      "question.upsert",
      "question.remove",
      "message.upsert",
      "agent.colors",
      "part.upsert",
      "part.remove",
      "diff.set",
      "todo.set",
      "message.remove",
      "session.error",
    ]);
    assertEquals(ops.find((op) => op.op === "agent.colors"), {
      op: "agent.colors",
      colors: {},
    });
    assertEquals(ops.slice(0, 2), [
      {
        op: "session.error",
        error: undefined,
        errorState: { revision: 1, observations: [] },
      },
      {
        op: "session.error",
        error: "fixture error",
        errorState: {
          revision: 2,
          observations: [{
            id: "observation-2",
            source: "event",
            message: "fixture error",
            kind: "UnknownError",
          }],
        },
      },
    ]);
    assertEquals(ops.at(-1), {
      op: "session.error",
      error: undefined,
      errorState: { revision: 3, observations: [] },
    });
    assert(entries.some((entry) => entry.attention.error === "fixture error"));
  } finally {
    await adapter.core.stop();
  }
});

test("adapter replays bootstrap events and invalidates streaming ownership on instance disposal", async () => {
  const settings = cfg();
  settings.harness.db = join(await fixture(), "missing.db");
  const session = {
    id: "ses_reload",
    projectID: "global",
    directory: "/project",
    title: "Before reload",
    time: { created: 1, updated: 1 },
  };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let release!: (response: Response) => void, queries = 0, resyncs = 0;
  const initialSnapshot = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetcher: typeof fetch = (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === "/global/health") {
      return Promise.resolve(Response.json({ version: "1.18.34" }));
    }
    if (path === "/experimental/session") {
      queries++;
      return queries === 1 ? initialSnapshot : Promise.resolve(
        Response.json([{ ...session, title: "After reload" }]),
      );
    }
    if (path === "/session/status") {
      return Promise.resolve(Response.json({}));
    }
    if (path === "/permission" || path === "/question") {
      return Promise.resolve(Response.json([]));
    }
    assertEquals(path, "/global/event");
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            options?.signal?.addEventListener("abort", () => value.close(), {
              once: true,
            });
          },
        }),
      ),
    );
  };
  const buffers = new StreamBuffers(),
    adapter = new Opencode1Adapter(settings, buffers, fetcher);
  const snapshots: IndexEntry[][] = [], updates: IndexEntry[] = [];
  const send = (type: string, properties: Record<string, unknown>) =>
    controller.enqueue(
      new TextEncoder().encode(
        `data: ${
          JSON.stringify({
            directory: "/project",
            payload: { type, properties },
          })
        }\n\n`,
      ),
    );
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      assert(Date.now() < deadline, "Bootstrap/disposal delivery stalled");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    adapter.core.subscriptions(session.id, 1);
    await adapter.core.start({
      connection: () => {},
      indexReset: (entries) => snapshots.push(structuredClone(entries)),
      indexUpsert: (entry) => updates.push(structuredClone(entry)),
      indexRemove: () => {},
      content: () => {},
      resync: () => {
        resyncs++;
      },
    });
    await wait(() => !!controller);
    send("server.connected", {});
    await wait(() => queries === 1);
    send("session.created", { info: session });
    send("session.status", { sessionID: session.id, status: { type: "busy" } });
    send("message.part.updated", {
      part: {
        id: "prt_reload",
        messageID: "msg_reload",
        sessionID: session.id,
        type: "text",
        text: "Open stream",
        time: { start: 2 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(snapshots, []);
    assertEquals(updates, []);
    release(Response.json([]));
    await wait(() => buffers.size === 1);
    assertEquals(snapshots, [[]]);
    assert(
      updates.some((entry) =>
        entry.id === session.id && entry.status === "busy"
      ),
    );
    send("server.instance.disposed", {});
    await wait(() => resyncs === 2);
    assertEquals(snapshots[1][0].title, "After reload");
    assertEquals(snapshots[1][0].status, "idle");
    assertEquals(
      buffers.size,
      0,
      "Disposed instance retained a stale streaming buffer",
    );
  } finally {
    release(Response.json([]));
    await adapter.core.stop();
  }
});
