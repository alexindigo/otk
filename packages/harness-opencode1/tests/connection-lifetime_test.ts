// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../../tests/support/resources.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { HarnessSink } from "@otk/harness";
import { SessionIndex } from "@otk/harness";
import { cfg, fixture } from "../../../tests/support/config.ts";
import { Opencode1Adapter } from "../adapter.ts";
import { Client } from "../client.ts";
import type { Session } from "../types.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function wait(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert(Date.now() < deadline, "Connection observation stalled");
    await tick();
  }
}
const session = (id: string): Session => ({
  id,
  directory: "/project",
  projectID: "project",
  title: id,
  time: { created: 1, updated: 1 },
});
const stages = [
  "health",
  "first page",
  "next page",
  "page body",
  "status",
  "permission",
  "question",
  "disposal",
] as const;
type Stage = typeof stages[number] | "event colour" | "event message";

async function recording(stage?: Stage, watchdog = false, failStatus = false) {
  const root = await fixture(), settings = cfg();
  settings.harness.db = join(root, "missing.db");
  if (watchdog) settings.harness.heartbeattimeout = 0.1;
  const held = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const paths: string[] = [], published: string[] = [];
  const index = new SessionIndex();
  let pages = 0, streamAborts = 0, health = 0;
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input)), path = url.pathname;
    paths.push(path);
    const page = path === "/experimental/session" ? ++pages : 0;
    if (path === "/global/health") health++;
    const hold =
      stage === "health" && path === "/global/health" && health === 1 ||
      stage === "first page" && page === 1 ||
      stage === "next page" && page === 2 ||
      stage === "page body" && page === 1 ||
      stage === "status" && path === "/session/status" ||
      stage === "permission" && path === "/permission" ||
      stage === "question" && path === "/question" ||
      stage === "disposal" && page === 2 ||
      stage === "event colour" && path === "/agent" ||
      stage === "event message" && path === "/session/root/message/msg";
    if (hold) {
      signals.push(options?.signal);
      if (stage !== "page body") reached.resolve();
      // Deliberately finish after cancellation: fencing must not depend on fetch
      // honouring abort, and stop must join even a late body/transport completion.
      if (stage !== "page body") await held.promise;
    }
    if (path === "/global/health") return Response.json({ version: "1.18.34" });
    if (page) {
      if (stage === "page body" && hold) {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await held.promise;
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify([session("stale")])),
              );
              controller.close();
            },
          }),
        );
        const json = response.json.bind(response);
        response.json = () => {
          const reading = json();
          reached.resolve();
          return reading;
        };
        return response;
      }
      return Response.json([session(hold ? "stale" : "root")], {
        headers: stage === "next page" && page === 1
          ? { "x-next-cursor": "second" }
          : undefined,
      });
    }
    if (path === "/session/status") {
      return failStatus
        ? new Response("inventory failed", { status: 500 })
        : Response.json({});
    }
    if (path === "/permission" || path === "/question") {
      return Response.json([]);
    }
    if (path === "/agent") return Response.json([]);
    if (path === "/session/root/message/msg") {
      return Response.json({ parts: [] });
    }
    assertEquals(path, "/global/event");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          if (options?.signal?.aborted) {
            controller.close();
            return;
          }
          options?.signal?.addEventListener("abort", () => {
            streamAborts++;
            try {
              controller.close();
            } catch { /* test already closed it */ }
          }, { once: true });
          controller.enqueue(new TextEncoder().encode(
            'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
          ));
        },
      }),
    );
  };
  const adapter = new Opencode1Adapter(settings, undefined, fetcher);
  const sink: HarnessSink = {
    index,
    connection: (state) => published.push(state),
    indexReset(entries) {
      index.reset(entries);
      published.push(`reset:${entries.map((entry) => entry.id).join(",")}`);
    },
    indexUpsert(entry) {
      index.upsert(entry);
      published.push(`upsert:${entry.id}`);
    },
    indexRemove(id) {
      index.remove(id);
      published.push(`remove:${id}`);
    },
    content: (_id, op) => published.push(`content:${op.op}`),
    resync: () => published.push("resync"),
  };
  const send = (type: string, properties: Record<string, unknown> = {}) => {
    streams.at(-1)!.enqueue(new TextEncoder().encode(
      JSON.stringify({
        directory: "/project",
        payload: { type, properties },
      }).replace(/^/, "data: ") + "\n\n",
    ));
  };
  await adapter.core.start(sink);
  if (stage === "disposal") {
    await wait(() => published.includes("resync"));
    send("server.instance.disposed");
  }
  if (stage === "event colour" || stage === "event message") {
    await wait(() => published.includes("resync"));
    adapter.core.subscriptions("root", 1);
    send("message.updated", {
      info: {
        id: "msg",
        sessionID: "root",
        role: "assistant",
        agent: "build",
        time: {
          created: 1,
          ...(stage === "event message" ? { completed: 2 } : {}),
        },
      },
    });
  }
  return {
    adapter,
    sink,
    index,
    signals,
    paths,
    published,
    streams,
    send,
    reached: reached.promise,
    release: () => held.resolve(),
    streamAborts: () => streamAborts,
    async close() {
      held.resolve();
      for (const stream of streams) {
        try {
          stream.close();
        } catch { /* already cancelled */ }
      }
      await adapter.core.stop();
      await tick();
      await Deno.remove(root, { recursive: true });
    },
  };
}

for (const stage of stages) {
  for (const outcome of ["abort", "publication"] as const) {
    test(`connection stop owns ${stage} ${outcome}`, async () => {
      const record = await recording(stage);
      try {
        await record.reached;
        const before = [...record.published];
        const paths = [...record.paths];
        const version = record.adapter.core.version;
        let stopped = false;
        const stop = record.adapter.core.stop().then(() => {
          stopped = true;
        });
        await tick();
        assert(!stopped, "Stop returned before owned work settled");
        const aborted = record.signals[0]?.aborted;
        record.release();
        await stop;
        if (outcome === "abort") {
          assertEquals(
            aborted,
            true,
            `Cancelled ${stage} has no aborted owner signal`,
          );
        } else {
          assertEquals(
            record.published,
            before,
            `Cancelled ${stage} published stale state`,
          );
          assertEquals(
            record.adapter.core.version,
            version,
            "Cancelled health changed public version",
          );
          assertEquals(
            record.paths,
            paths,
            "Cancelled bootstrap started another read",
          );
        }
      } finally {
        await record.close();
      }
    });
  }
}

for (const ending of ["disconnect", "watchdog"] as const) {
  test(`connection ${ending} retires bootstrap before reconnect`, async () => {
    const record = await recording("next page", ending === "watchdog");
    try {
      await record.reached;
      const before = [...record.published];
      if (ending === "disconnect") record.streams[0].close();
      await wait(() => record.streamAborts() === 1);
      const aborted = record.signals[0]?.aborted;
      record.release();
      await wait(() => record.streams.length === 2);
      await wait(() => record.published.includes("resync"));
      assertEquals(record.published.slice(before.length), [
        "reconnecting",
        "reset:root",
        "connected",
        "resync",
      ], "Retired bootstrap leaked into the replacement connection");
      assertEquals(aborted, true);
      assertEquals(record.index.get("stale"), undefined);
    } finally {
      await record.close();
    }
  });
}

test("repeated start rejects without replacing the active sink or connection", async () => {
  const record = await recording();
  const replacement: string[] = [];
  try {
    await wait(() => record.published.includes("resync"));
    await assertRejects(
      () =>
        record.adapter.core.start({
          ...record.sink,
          connection: (state) => replacement.push(state),
          indexUpsert: (entry) => replacement.push(entry.id),
        }),
      Error,
      "already started",
    );
    record.send("session.status", {
      sessionID: "root",
      status: { type: "busy" },
    });
    await wait(() => record.index.get("root")?.status === "busy");
    assertEquals(record.streams.length, 1);
    assertEquals(replacement, []);
  } finally {
    await record.close();
  }
});

for (const stage of ["event colour", "event message"] as const) {
  test(`watchdog fences asynchronous ${stage} publication`, async () => {
    const record = await recording(stage, true);
    try {
      await record.reached;
      const before = [...record.published];
      await wait(() => record.streamAborts() === 1);
      record.release();
      await wait(() => record.streams.length === 2);
      await wait(() =>
        record.published.filter((value) => value === "resync").length === 2
      );
      assertEquals(record.published.slice(before.length), [
        "reconnecting",
        "reset:root",
        "connected",
        "resync",
      ], "Retired event published into the replacement connection");
    } finally {
      await record.close();
    }
  });
}

test("native finite read deadline remains active with an owner signal", async () => {
  const owner = new AbortController();
  let reason: unknown;
  const client = new Client(
    cfg().harness,
    (_input, options) =>
      new Promise((resolve) => {
        options!.signal!.addEventListener("abort", () => {
          reason = options!.signal!.reason;
          resolve(Response.json({}));
        }, { once: true });
      }),
  );
  const cleanup = setTimeout(() => owner.abort(), 1000);
  try {
    await client.json("/global/health", { signal: owner.signal, timeout: 10 });
    assert(reason instanceof DOMException);
    assertEquals(
      reason.name,
      "TimeoutError",
      "Owner signal disabled the finite request deadline",
    );
    assertEquals(owner.signal.aborted, false);
  } finally {
    clearTimeout(cleanup);
    owner.abort();
  }
});

test("failed bootstrap aborts and joins sibling inventory reads", async () => {
  const record = await recording("permission", false, true);
  try {
    await record.reached;
    await wait(() => record.streamAborts() === 1);
    let stopped = false;
    const stop = record.adapter.core.stop().then(() => {
      stopped = true;
    });
    await tick();
    const joined = !stopped;
    const aborted = record.signals[0]?.aborted;
    record.release();
    await stop;
    assertEquals(joined, true, "Failed bootstrap detached its sibling reads");
    assertEquals(aborted, true, "Failed inventory left its siblings alive");
    assertEquals(record.published, ["connecting"]);
  } finally {
    await record.close();
  }
});

test("concurrent stops join one owner and start waits for completed teardown", async () => {
  const record = await recording("first page");
  try {
    await record.reached;
    const stop = record.adapter.core.stop();
    assert(
      stop === record.adapter.core.stop(),
      "Concurrent stops have different owners",
    );
    await assertRejects(
      () => record.adapter.core.start(record.sink),
      Error,
      "already started",
    );
    record.release();
    await stop;
    await record.adapter.core.start(record.sink);
    await wait(() => record.published.includes("resync"));
    assertEquals(record.streams.length, 2);
    assertEquals(record.published, [
      "connecting",
      "connecting",
      "reset:root",
      "connected",
      "resync",
    ]);
  } finally {
    await record.close();
  }
});

test("duplicate connected frames cannot replace or overlap bootstrap work", async () => {
  const record = await recording("first page");
  try {
    await record.reached;
    record.send("server.connected");
    record.send("server.connected");
    await tick();
    await tick();
    const pages = record.paths.filter((path) =>
      path === "/experimental/session"
    ).length;
    record.release();
    await wait(() => record.published.includes("resync"));
    assertEquals(pages, 1, "Connected frames launched untracked bootstraps");
    assertEquals(
      record.published.filter((value) => value === "connected").length,
      1,
    );
  } finally {
    await record.close();
  }
});
