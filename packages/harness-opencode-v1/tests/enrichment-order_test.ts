// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { cfg, fixture } from "../../../tests/support/config.ts";
import { test } from "../../../tests/support/resources.ts";
import { OpencodeV1Adapter } from "../adapter.ts";
import type { Envelope } from "../types.ts";
import type { ContentOp } from "@otk/protocol";
import type { DigestPort, ProviderReadPort } from "@otk/harness";
import { History } from "../history.ts";
import { mapIndex } from "../map.ts";
import type { Session } from "../types.ts";

Deno.test("optional boundary recall retains its non-urgent provider-read priority", async () => {
  const priorities: string[] = [];
  const reads: ProviderReadPort = {
    read: ((_kind, _input, options) => {
      priorities.push(options.priority);
      return Promise.resolve([]);
    }) as ProviderReadPort["read"],
    release() {},
  };
  const history = new History(reads, cfg().attachments);
  try {
    await history.entry("opcv1-s", "message", undefined, "visible");
    await history.entry("opcv1-s", "message");
    assertEquals(priorities, ["visible", "user"]);
  } finally {
    history.close();
  }
});

test("accepted deletion retires optional reads before its digest acknowledgement", async () => {
  const clock = Promise.withResolvers<{ lastOutput: number | null }>();
  const deletion = Promise.withResolvers<void>();
  let clockSignal: AbortSignal | undefined, deleting = false;
  const session: Session = {
    id: "ses_deleted",
    projectID: "global",
    directory: "/project",
    title: "Deleted",
    time: { created: 1, updated: 1 },
  };
  const digest: DigestPort = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    catalog: () =>
      Promise.resolve({
        entries: [mapIndex(session)],
        authoritative: true,
        hints: [],
      }),
    observe() {},
    scope() {},
    release() {},
    deleted() {
      deleting = true;
      return deletion.promise;
    },
    detail: () => Promise.reject(new Error("Unexpected detail")),
    transcriptMetadata: () => Promise.reject(new Error("Unexpected metadata")),
    deleteIntent: () => Promise.resolve(),
    read: ((kind, _input, options) => {
      if (kind === "message.clock") {
        clockSignal = options.signal;
        return clock.promise;
      }
      if (kind === "catalog.agents") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected read ${kind}`));
    }) as DigestPort["read"],
  };
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const config = cfg();
  config.harness.db = `${await fixture()}/missing.db`;
  const adapter = new OpencodeV1Adapter(config, undefined, (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/global/health") {
      return Promise.resolve(Response.json({ version: "1.18.34" }));
    }
    assertEquals(path, "/global/event");
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            feed = controller;
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      ),
    );
  }, digest);
  const ops: ContentOp[] = [];
  const emit = (type: string, properties: Record<string, unknown>) =>
    feed.enqueue(
      new TextEncoder().encode(
        `data: ${
          JSON.stringify({
            directory: "/project",
            payload: { type, properties },
          })
        }\n\n`,
      ),
    );
  adapter.core.subscriptions("opcv1-ses_deleted", 1);
  try {
    await adapter.core.start({
      connection() {},
      indexReset() {},
      indexUpsert() {},
      indexRemove() {},
      bootstrapComplete() {},
      invalidate() {},
      content(_id, op) {
        ops.push(op);
      },
    });
    while (!feed) await new Promise((resolve) => setTimeout(resolve, 0));
    emit("server.connected", {});
    emit("message.updated", {
      info: {
        id: "msg_deleted",
        sessionID: session.id,
        role: "assistant",
        agent: "build",
        time: { created: 1, completed: 10 },
      },
    });
    const deadline = Date.now() + 1000;
    while (!clockSignal && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert(clockSignal);
    emit("session.deleted", { info: session });
    while (!deleting && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert(deleting);
    assertEquals(
      clockSignal.aborted,
      true,
      "native deletion is authority before worker acknowledgement",
    );
    clock.resolve({ lastOutput: 5 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(ops.some((op) => op.op === "message.clock"), false);
  } finally {
    clock.resolve({ lastOutput: 5 });
    deletion.resolve();
    await adapter.core.stop();
  }
});

test("held optional completion read cannot hold another session's ordered authority", async () => {
  const held = Promise.withResolvers<Response>();
  const a = "opcv1-ses_a", b = "opcv1-ses_b";
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  let reads = 0;
  const fetcher: typeof fetch = (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/global/health") {
      return Promise.resolve(Response.json({ version: "1.18.34" }));
    }
    if (path === "/experimental/session" || path === "/agent") {
      return Promise.resolve(Response.json([]));
    }
    if (path === "/global/event") {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              feed = controller;
              init?.signal?.addEventListener(
                "abort",
                () => controller.close(),
                { once: true },
              );
            },
          }),
        ),
      );
    }
    if (path.endsWith("/message/msg_a")) {
      reads++;
      return held.promise;
    }
    throw new Error(`Unexpected read ${path}`);
  };
  const config = cfg();
  config.harness.db = `${await fixture()}/missing.db`;
  const adapter = new OpencodeV1Adapter(config, undefined, fetcher);
  const ops: { session: string; event: ContentOp }[] = [];
  let busy = false;
  adapter.core.subscriptions(a, 1);
  adapter.core.subscriptions(b, 1);
  const emit = (type: string, properties: Record<string, unknown>) => {
    const envelope: Envelope = {
      directory: "/project",
      payload: { type, properties },
    };
    feed.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(envelope)}\n\n`),
    );
  };
  const info = {
    id: "msg_a",
    sessionID: "ses_a",
    role: "assistant",
    agent: "build",
    providerID: "fake",
    modelID: "scripted",
    time: { created: 1, completed: 10 },
  };
  try {
    await adapter.core.start({
      connection() {},
      indexReset() {},
      indexRemove() {},
      bootstrapComplete() {},
      invalidate() {},
      indexUpsert(entry) {
        if (entry.id === b && entry.status === "busy") busy = true;
      },
      content(session, event) {
        ops.push({ session, event });
      },
    });
    while (!feed) await new Promise((resolve) => setTimeout(resolve, 5));
    emit("server.connected", {});
    emit("message.updated", { info });
    emit("session.created", {
      info: {
        id: "ses_b",
        directory: "/project",
        projectID: "global",
        title: "B",
        time: { created: 1, updated: 1 },
      },
    });
    emit("session.status", { sessionID: "ses_b", status: { type: "busy" } });
    emit("message.part.updated", {
      part: {
        id: "prt_b",
        messageID: "msg_b",
        sessionID: "ses_b",
        type: "text",
        text: "B is visible",
        time: { start: 1 },
      },
    });
    const until = Date.now() + 1000;
    while (
      !ops.some(({ session, event }) =>
        session === b && event.op === "part.upsert"
      ) && Date.now() < until
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    assert(busy, "B status must pass A's held decoration");
    assert(
      ops.some(({ session, event }) =>
        session === a && event.op === "message.upsert"
      ),
      "A terminal header publishes before enrichment",
    );
    assert(
      ops.some(({ session, event }) =>
        session === b && event.op === "part.upsert"
      ),
      "B text reaches its consumer while A is held",
    );
    held.resolve(
      Response.json({
        info,
        parts: [{
          id: "prt_a",
          type: "text",
          time: { start: 1, end: 5 },
          text: "A",
        }],
      }),
    );
    const refined = Date.now() + 1000;
    while (
      !ops.some(({ event }) => event.op === "message.clock") &&
      Date.now() < refined
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    const clock = ops.find(({ event }) => event.op === "message.clock")?.event;
    assert(clock?.op === "message.clock");
    assertEquals(clock.lastOutput, 5);
    assertEquals(reads, 1);
  } finally {
    held.resolve(Response.json({ info, parts: [] }));
    await adapter.core.stop();
  }
});
