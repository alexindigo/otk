// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { SessionIndex } from "@otk/harness";
import type { ContentOp } from "@otk/protocol";
import { StreamBuffers } from "@otk/content";
import { emptyContent, reduce } from "@otk/client";
import { IndexStore } from "../../../core/index/store.ts";
import { cfg, fixture } from "../../../tests/support/config.ts";
import { Opencode1Adapter } from "../adapter.ts";
import { Attention } from "../attention.ts";
import { consumeEvents } from "../events.ts";
import { AgentColors } from "../agents.ts";
import { Client } from "../client.ts";
import { MessageRecovery } from "../recovery.ts";
import { mapIndex, mapMessage } from "../map.ts";
import type { Info, Session } from "../types.ts";

const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert(Date.now() < deadline, "F7 observation stalled");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const session = (
  id: string,
  parentID?: string,
  directory = "/project",
): Session => ({
  id,
  parentID,
  directory,
  projectID: "project",
  title: id,
  time: { created: 1, updated: 1 },
});
const info = (id = "msg_live", sessionID = "root"): Info => ({
  id,
  sessionID,
  role: "assistant",
  agent: "build",
  time: { created: 2 },
  providerID: "fake",
  modelID: "scripted",
});

async function recording(
  extra: (url: URL, options?: RequestInit) => Promise<Response> | undefined =
    () => undefined,
  seeds = [session("root"), session("other")],
  delayed = false,
) {
  const settings = cfg();
  settings.harness.db = join(await fixture(), "missing.db");
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  const connections: string[] = [], ops: { id: string; op: ContentOp }[] = [];
  const index = new IndexStore(), buffers = new StreamBuffers();
  let resets = 0, streams = 0;
  const fetcher: typeof fetch = (input, options) => {
    const url = new URL(String(input));
    const response = extra(url, options);
    if (response) return response;
    if (url.pathname === "/global/health") {
      return Promise.resolve(Response.json({ version: "1.18.34" }));
    }
    if (url.pathname === "/experimental/session") {
      return (delayed ? held : Promise.resolve()).then(() =>
        Response.json(seeds)
      );
    }
    if (url.pathname === "/agent") {
      return Promise.resolve(
        Response.json([{ name: "build", color: "#abcdef" }]),
      );
    }
    if (url.pathname === "/session/status") {
      return Promise.resolve(Response.json({}));
    }
    if (url.pathname === "/permission" || url.pathname === "/question") {
      return Promise.resolve(Response.json([]));
    }
    assertEquals(url.pathname, "/global/event");
    streams++;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            const close = () => {
              try {
                value.close();
              } catch { /* already ended */ }
            };
            options?.signal?.addEventListener("abort", close, { once: true });
          },
        }),
      ),
    );
  };
  const adapter = new Opencode1Adapter(settings, buffers, fetcher);
  adapter.core.subscriptions("root", 1);
  await adapter.core.start({
    index,
    connection: (state) => connections.push(state),
    indexReset: (entries) => {
      index.reset(entries);
      resets++;
    },
    indexUpsert: (entry) => index.upsert(entry),
    indexRemove: (id) => index.remove(id),
    content: (id, op) => ops.push({ id, op }),
    resync: () => {},
  });
  await wait(() => !!controller);
  const raw = (text: string) =>
    controller.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));
  const send = (type: string, properties: Record<string, unknown> = {}) =>
    raw(
      JSON.stringify({ directory: "/project", payload: { type, properties } }),
    );
  send("server.connected");
  if (!delayed) await wait(() => resets === 1);
  let barrier = 0;
  const drain = async () => {
    const attempt = ++barrier;
    send("session.status", {
      sessionID: "other",
      status: { type: "retry", attempt, message: "barrier", next: 0 },
    });
    await wait(() => index.get("other")?.retry?.attempt === attempt);
  };
  return {
    adapter,
    buffers,
    index,
    ops,
    connections,
    send,
    raw,
    drain,
    release,
    resets: () => resets,
    streams: () => streams,
    disconnect: () => controller.close(),
  };
}

Deno.test("SSE contains bad JSON, bad envelopes and rejected consumers without losing subsequent frames", async () => {
  const failures: unknown[] = [], received: string[] = [];
  await consumeEvents(
    new Response(
      [
        "{bad",
        "null",
        '{"payload":{"type":"poison"}}',
        '{"payload":{"type":"healthy"}}',
      ].map((raw) => `data: ${raw}\n\n`).join(""),
    ),
    () => {},
    (event) => {
      if (event.payload.type === "poison") throw new Error("mapping rejected");
      received.push(event.payload.type);
    },
    undefined,
    (error) => failures.push(error),
  );
  assertEquals(failures.length, 3);
  assertEquals(received, ["healthy"]);
});

Deno.test("adapter contains buffered and live poisoned events and failed follow-up reads to their session", async () => {
  let reads = 0;
  const record = await recording(
    (url) => {
      if (url.pathname.includes("/message/")) {
        reads++;
        return Promise.resolve(
          new Response("follow-up failed", { status: 500 }),
        );
      }
    },
    undefined,
    true,
  );
  const warnings: unknown[][] = [], original = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    record.send("question.asked", {
      id: "bad",
      sessionID: "root",
      questions: null,
    });
    record.send("session.status", {
      sessionID: "other",
      status: { type: "busy" },
    });
    record.release();
    await wait(() => record.index.get("other")?.status === "busy");
    record.raw("{bad");
    record.raw("null");
    record.send("message.updated", {
      info: { ...info(), time: { created: 2, completed: 3 } },
    });
    record.send("session.updated", { info: { id: "root" } });
    record.send("session.status", {
      sessionID: "root",
      status: { type: "invalid" },
    });
    record.adapter.core.subscriptions("other", 1);
    record.send("message.part.updated", {
      part: {
        id: "healthy-part",
        messageID: "healthy-message",
        sessionID: "other",
        type: "text",
        text: "Healthy content still arrives",
        time: { start: 2, end: 3 },
      },
    });
    await record.drain();
    assertEquals(reads, 1);
    assertEquals(record.streams(), 1);
    assertEquals(record.connections, ["connecting", "connected"]);
    assertEquals(record.resets(), 1);
    assertEquals(
      record.index.get("root")!.attention.questions,
      0,
      "Failed mapping registered a phantom request",
    );
    assertEquals(
      record.index.get("root")!.status,
      "idle",
      "Poisoned status mutated the shared owner",
    );
    assertEquals(
      record.index.get("root")!.attention.error,
      undefined,
      "Internal failures impersonated native errors",
    );
    assert(warnings.length >= 5);
    assert(
      record.ops.some(({ id, op }) =>
        id === "other" && op.op === "part.upsert" &&
        JSON.stringify(op).includes("Healthy content still arrives")
      ),
    );
  } finally {
    console.warn = original;
    record.release();
    await record.adapter.core.stop();
  }
});

Deno.test("connector and core use the same index owner, including authoritative directory changes", async () => {
  const directories: string[] = [];
  const record = await recording((url) => {
    if (url.pathname === "/agent") {
      directories.push(url.searchParams.get("directory")!);
      return Promise.resolve(Response.json([]));
    }
  });
  try {
    const entry = record.index.get("root")!;
    record.index.upsert({
      ...entry,
      title: "Core owner edit",
      directory: "/changed",
    });
    record.send("session.status", {
      sessionID: "root",
      status: { type: "retry", attempt: 8, message: "keep metadata", next: 0 },
    });
    await record.drain();
    await record.adapter.capabilities.agents.listAgents("root");
    assertEquals(directories, ["/changed"]);
    assertEquals(record.index.get("root")!.title, "Core owner edit");
    assertEquals(record.index.get("root")!.retry?.attempt, 8);
  } finally {
    await record.adapter.core.stop();
  }
});

Deno.test("colour cache shares in-flight directory lookups, retries failures and invalidates on disposal", async () => {
  let calls = 0, release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  const colors = new AgentColors(
    new Client(cfg().harness, () => {
      const call = ++calls;
      return held.then(() =>
        call === 1
          ? new Response("failed", { status: 500 })
          : Response.json([{ name: "build", color: "#123456" }])
      );
    }),
  );
  const first = colors.get("/project"), second = colors.get("/project");
  assert(first === second);
  release();
  const failed = await Promise.allSettled([first, second]);
  assert(failed.every((result) => result.status === "rejected"));
  assertEquals((await colors.get("/project")).get("build"), "#123456");
  assertEquals(calls, 2);
  await colors.get("/project");
  assertEquals(calls, 2);
  colors.clear();
  await colors.get("/project");
  assertEquals(calls, 3);
});

Deno.test("recovery coalesces parts within one message and cancels scheduled reads before they start", async () => {
  let reads = 0, release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  const received: string[][] = [];
  const recovery = new MessageRecovery(
    async () => {
      reads++;
      await held;
      return { info: info(), parts: [] };
    },
    (_id, _snapshot, parts) => received.push([...parts]),
    (error) => {
      throw error;
    },
  );
  try {
    recovery.touch("root", "cancelled", "first");
    recovery.release("root");
    await new Promise((resolve) => setTimeout(resolve, 75));
    assertEquals(reads, 0);
    recovery.touch("root", "msg_live", "first");
    recovery.touch("root", "msg_live", "second");
    await wait(() => reads === 1);
    recovery.part("msg_live", "first");
    release();
    await wait(() => received.length === 1);
    assertEquals(received, [["second"]]);
    assertEquals(reads, 1);
  } finally {
    release();
    await recovery.stop();
  }
});

Deno.test("attention changes only the affected ancestor path and handles duplicates, moves and late parents", () => {
  const index = new SessionIndex();
  const entries = Array.from(
    { length: 2000 },
    (_, i) => mapIndex(session(`unrelated-${i}`)),
  );
  entries.push(
    ...[
      session("a"),
      session("b"),
      session("child", "a"),
      session("leaf", "child"),
    ].map(mapIndex),
  );
  index.reset(entries);
  const published: string[] = [], looked: string[] = [];
  const attention = new Attention(
    (id) => {
      looked.push(id);
      return index.get(id);
    },
    (entry) => {
      published.push(entry.id);
      index.upsert(entry);
    },
    (id) => index.remove(id),
    (id) => index.descendants(id),
  );
  attention.reset(entries, [], []);
  attention.change("leaf", "permissions", 1);
  assertEquals(published, ["leaf", "child", "a"]);
  assertEquals(looked.some((id) => id.startsWith("unrelated")), false);
  assertEquals(index.get("a")!.attention.childPermissions, 1);
  attention.upsert({ ...index.get("child")!, parentID: "b" });
  assertEquals(index.get("a")!.attention.childPermissions, 0);
  assertEquals(index.get("b")!.attention.childPermissions, 1);
  attention.remove("child");
  assertEquals(index.get("b")!.attention.childPermissions, 0);
  attention.upsert(mapIndex(session("child", "a")));
  assertEquals(index.get("a")!.attention.childPermissions, 1);
  attention.change("missing", "questions", 1);
  attention.upsert(mapIndex(session("missing", "a")));
  assertEquals(index.get("missing")!.attention.questions, 1);
  assertEquals(index.get("a")!.attention.childQuestions, 1);
  attention.change("leaf", "permissions", -1);
  assertEquals(index.get("a")!.attention.childPermissions, 0);
});

Deno.test("attention request replay is idempotent and moving owners updates only their families", async () => {
  const record = await recording(undefined, [
    session("root"),
    session("other"),
    session("child", "root"),
  ]);
  try {
    const asked = {
      id: "q",
      sessionID: "child",
      questions: [{ question: "Choose", options: [{ label: "yes" }] }],
    };
    record.send("question.asked", asked);
    record.send("question.asked", asked);
    await record.drain();
    assertEquals(record.index.get("child")!.attention.questions, 1);
    assertEquals(record.index.get("root")!.attention.childQuestions, 1);
    record.send("question.asked", { ...asked, sessionID: "other" });
    record.send("question.replied", { requestID: "q", sessionID: "other" });
    record.send("question.replied", { requestID: "q", sessionID: "other" });
    await record.drain();
    for (const entry of record.index.values()) {
      assertEquals(entry.attention.questions, 0);
      assertEquals(entry.attention.childQuestions, 0);
    }
  } finally {
    await record.adapter.core.stop();
  }
});

Deno.test("reconnect coalesces unseeded deltas with one trailing snapshot and authoritative updates end recovery", async () => {
  let reads = 0, collections = 0, inFlight = 0, maximum = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  let text = "Before reconnect";
  const record = await recording((url, options) => {
    if (/\/message$/.test(url.pathname)) {
      collections++;
      return Promise.resolve(Response.json([]));
    }
    if (url.pathname.includes("/message/")) {
      const n = ++reads;
      maximum = Math.max(maximum, ++inFlight);
      options?.signal?.addEventListener("abort", release, { once: true });
      const snapshot = text;
      return (n === 1 ? held : Promise.resolve()).then(() => {
        inFlight--;
        return Response.json({
          info: info(),
          parts: [{
            id: "part",
            messageID: "msg_live",
            sessionID: "root",
            type: "text",
            text: snapshot,
            time: { start: 2 },
          }],
        });
      });
    }
  });
  const delta = () =>
    record.send("message.part.delta", {
      sessionID: "root",
      messageID: "msg_live",
      partID: "part",
      field: "text",
      delta: "!",
    });
  try {
    record.disconnect();
    await wait(() => record.streams() === 2);
    record.send("server.connected");
    await wait(() => record.resets() === 2);
    for (let i = 0; i < 50; i++) delta();
    await wait(() => reads === 1);
    text = "Authoritative after fifty more deltas";
    for (let i = 0; i < 50; i++) delta();
    await record.drain();
    await new Promise((resolve) => setTimeout(resolve, 75));
    assertEquals(reads, 1);
    release();
    await wait(() =>
      reads === 2 &&
      record.ops.filter(({ op }) => op.op === "part.upsert").length === 2
    );
    assertEquals(maximum, 1);
    assertEquals(collections, 0);
    assertEquals(
      record.buffers.size,
      0,
      "HTTP snapshot invented an appendable seed",
    );
    const rendered = () =>
      record.ops.filter(({ id }) => id === "root").reduce(
        (state, { op }) => reduce(state, op),
        { ...emptyContent(), messages: [mapMessage(info())] },
      ).messages[0].parts[0];
    const recovered = rendered();
    assert(recovered.kind === "text");
    assertEquals(recovered.blocks, [{
      b: "paragraph",
      inline: [{ i: "text", text }],
    }]);
    record.send("message.part.updated", {
      part: {
        id: "part",
        messageID: "msg_live",
        sessionID: "root",
        type: "text",
        text,
        time: { start: 2 },
      },
    });
    await record.drain();
    for (let i = 0; i < 50; i++) delta();
    await record.drain();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assertEquals(reads, 2);
    const last = record.ops.findLast(({ op }) => op.op === "part.blocks")!;
    assert(JSON.stringify(last).includes(text + "!".repeat(50)));
    const streamed = rendered();
    assert(streamed.kind === "text");
    assertEquals(streamed.blocks, [{
      b: "paragraph",
      inline: [{ i: "text", text: text + "!".repeat(50) }],
    }]);
  } finally {
    release();
    await record.adapter.core.stop();
  }
});

Deno.test("agent colours are shared per directory across sessions, pages, events and reconnect", async () => {
  const lookups = new Map<string, number>();
  const record = await recording((url) => {
    if (url.pathname === "/agent") {
      const directory = url.searchParams.get("directory")!;
      lookups.set(directory, (lookups.get(directory) ?? 0) + 1);
      return Promise.resolve(
        Response.json([{ name: "build", color: "#abcdef" }]),
      );
    }
    if (/\/session\/(root|other|third)$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1)!;
      return Promise.resolve(
        Response.json(
          session(id, undefined, id === "third" ? "/second" : "/project"),
        ),
      );
    }
    if (/\/message$/.test(url.pathname)) {
      return Promise.resolve(
        Response.json([{
          info: info("page", url.pathname.split("/")[2]),
          parts: [],
        }]),
      );
    }
  }, [
    session("root"),
    session("other"),
    session("third", undefined, "/second"),
  ]);
  try {
    await Promise.all(
      ["root", "other", "third"].map((id) =>
        record.adapter.core.listMessages(id, { limit: 10 })
      ),
    );
    record.adapter.core.subscriptions("other", 1);
    record.send("message.updated", { info: info("event-root", "root") });
    record.send("message.updated", { info: info("event-other", "other") });
    await record.drain();
    record.disconnect();
    await wait(() => record.streams() === 2);
    record.send("server.connected");
    await wait(() => record.resets() === 2);
    record.send("message.updated", { info: info("after-reconnect", "root") });
    await record.drain();
    assertEquals([...lookups], [["/project", 1], ["/second", 1]]);
    for (
      const { op } of record.ops.filter(({ op }) => op.op === "message.upsert")
    ) {
      assert(op.op === "message.upsert");
      assertEquals(op.message.agentColor, "#abcdef");
    }
  } finally {
    await record.adapter.core.stop();
  }
});

Deno.test("disconnect while bootstrap drains cannot start recovery in the retired generation", async () => {
  let reads = 0;
  const record = await recording(
    (url) => {
      if (url.pathname.includes("/message/")) {
        reads++;
        return Promise.resolve(Response.json({ info: info(), parts: [] }));
      }
    },
    undefined,
    true,
  );
  try {
    record.send("message.part.delta", {
      sessionID: "root",
      messageID: "msg_live",
      partID: "part",
      field: "text",
      delta: "!",
    });
    // Bootstrap is still waiting for its held index response; this delta is buffered.
    await new Promise((resolve) => setTimeout(resolve, 10));
    record.disconnect();
    record.release();
    await wait(() => record.connections.includes("reconnecting"));
    await new Promise((resolve) => setTimeout(resolve, 75));
    assertEquals(reads, 0);
  } finally {
    record.release();
    await record.adapter.core.stop();
  }
});

for (
  const ending of [
    "unsubscribe",
    "part update",
    "part removal",
    "message removal",
    "session deletion",
    "disposal",
    "disconnect",
    "stop",
  ] as const
) {
  Deno.test(`unseeded recovery cancels pending reads and suppresses stale output on ${ending}`, async () => {
    let release!: () => void, started = false, aborted = false;
    const held = new Promise<void>((resolve) => release = resolve);
    const record = await recording((url, options) => {
      if (!url.pathname.includes("/message/")) return;
      started = true;
      options?.signal?.addEventListener("abort", () => {
        aborted = true;
        release();
      }, { once: true });
      return held.then(() =>
        Response.json({
          info: info(),
          parts: [{
            id: "part",
            messageID: "msg_live",
            sessionID: "root",
            type: "text",
            text: "STALE SNAPSHOT",
            time: { start: 2 },
          }],
        })
      );
    });
    let stopped = false;
    try {
      record.send("message.part.delta", {
        sessionID: "root",
        messageID: "msg_live",
        partID: "part",
        field: "text",
        delta: "!",
      });
      await wait(() => started);
      if (ending === "unsubscribe") {
        record.adapter.core.subscriptions("root", 0);
      } else if (ending === "stop") {
        await record.adapter.core.stop();
        stopped = true;
      } else if (ending === "disconnect") record.disconnect();
      else if (ending === "disposal") record.send("server.instance.disposed");
      else if (ending === "session deletion") {
        record.send("session.deleted", { info: session("root") });
      } else if (ending === "message removal") {
        record.send("message.removed", {
          sessionID: "root",
          messageID: "msg_live",
        });
      } else if (ending === "part removal") {
        record.send("message.part.removed", {
          sessionID: "root",
          messageID: "msg_live",
          partID: "part",
        });
      } else {record.send("message.part.updated", {
          part: {
            id: "part",
            sessionID: "root",
            messageID: "msg_live",
            type: "text",
            text: "Authoritative update",
            time: { start: 2 },
          },
        });}
      await wait(() => aborted);
      release();
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert(!JSON.stringify(record.ops).includes("STALE SNAPSHOT"));
    } finally {
      release();
      if (!stopped) await record.adapter.core.stop();
    }
  });
}
