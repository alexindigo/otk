// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Backoff, Watchdog } from "../mod.ts";
import { consumeEvents } from "../mod.ts";
import { mapDiffs, mapMessage, mapPart, mapPermission } from "../mod.ts";

Deno.test("watchdog detects silence and backoff resets on connected", async () => {
  let fired = 0;
  const watchdog = new Watchdog(20, () => fired++);
  watchdog.touch();
  await new Promise((r) => setTimeout(r, 10));
  watchdog.touch();
  await new Promise((r) => setTimeout(r, 12));
  assertEquals(fired, 0);
  await new Promise((r) => setTimeout(r, 15));
  assertEquals(fired, 1);
  watchdog.stop();
  const backoff = new Backoff(3);
  assertEquals(
    [backoff.next(), backoff.next(), backoff.next(), backoff.next()],
    [1000, 2000, 3000, 3000],
  );
  backoff.connected();
  assertEquals(backoff.next(), 1000);
});
Deno.test("SSE accepts fragmented CRLF, comments and multiline data; all bytes count", async () => {
  const chunks = [
    ":comment\r",
    '\n\r\ndata: {"payload":\r\ndata: {"type":"server.connected","properties":{}}}\r',
    "\n\r\n",
  ];
  let bytes = 0;
  const types: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  await consumeEvents(
    new Response(stream),
    () => bytes++,
    (event) => {
      types.push(event.payload.type);
    },
  );
  assertEquals(bytes, 3);
  assertEquals(types, ["server.connected"]);
});
Deno.test("SSE assembles a large UTF-8 event from chunks without losing delimiter boundaries", async () => {
  const delta = "é中".repeat(400_000);
  const envelope = {
    directory: "/project",
    payload: { type: "message.part.delta", properties: { delta } },
  };
  const encoded = new TextEncoder().encode(
    `data: ${
      JSON.stringify(envelope)
    }\r\n\r\ndata: {"payload":{"type":"server.heartbeat","properties":{}}}\r\n\r\n`,
  );
  const received: unknown[] = [];
  let count = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += 16_381) {
        controller.enqueue(encoded.slice(offset, offset + 16_381));
      }
      controller.close();
    },
  });
  await consumeEvents(
    new Response(stream),
    () => count++,
    (event) => {
      received.push(event);
    },
  );
  assertEquals(received, [envelope, {
    payload: { type: "server.heartbeat", properties: {} },
  }]);
  assertEquals(count, Math.ceil(encoded.length / 16_381));
});
Deno.test("mapping strips harness metadata, handles all part kinds and interrupted errors", () => {
  const base = {
    id: "part",
    messageID: "message",
    sessionID: "ses_root",
    metadata: { private: "secret" },
  };
  const parts = [
    "text",
    "reasoning",
    "file",
    "agent",
    "step-start",
    "step-finish",
    "compaction",
    "snapshot",
  ].map((type) =>
    mapPart({
      ...base,
      type,
      text: "# Content",
      time: { start: 1 },
      mime: "text/plain",
      name: "agent",
      filename: "fixture",
      cost: 1,
    })
  );
  assertEquals(parts.map((p) => p.kind), [
    "text",
    "reasoning",
    "file",
    "agent",
    "step",
    "step",
    "compaction",
    "meta",
  ]);
  const message = mapMessage({
    id: "message",
    sessionID: "ses_root",
    role: "assistant",
    time: { created: 1, completed: 2 },
    agent: "build",
    providerID: "fake",
    modelID: "scripted",
    error: { name: "MessageAbortedError", data: { message: "Interrupted" } },
  });
  assert(message.role === "assistant" && message.interrupted);
  assert(!JSON.stringify(parts).includes("private"));
  const bash = mapPart({
    ...base,
    type: "tool",
    tool: "bash",
    callID: "call",
    state: {
      status: "completed",
      input: { command: "echo otk", workdir: "/project" },
      output: "otk",
      metadata: { exit: 0 },
    },
  });
  assert(
    bash.kind === "tool" && bash.call.tool === "bash" &&
      bash.call.cwd === "/project" && bash.call.exitCode === 0,
  );
  const generic = mapPart({
    ...base,
    type: "tool",
    tool: "custom",
    callID: "call",
    state: {
      status: "completed",
      input: { query: "summary\nrest" },
      output: "x".repeat(70_000),
    },
  });
  assert(generic.kind === "tool" && generic.call.tool === "external");
  assertEquals(generic.call.output?.length, 65_536);
});
Deno.test("unrecognized part kinds retain their external name and bounded payload", () => {
  const part = mapPart({
    id: "part",
    messageID: "message",
    sessionID: "session",
    type: "plugin.card",
    metadata: { title: "😀".repeat(40000) },
  });
  assert(part.kind === "external");
  assertEquals(part.name, "plugin.card");
  assertEquals(part.id, "part");
  assert(part.data!.includes('"title"'));
  assert(new TextEncoder().encode(part.data).length <= 65536);
  assert(!part.data!.includes("�"));
});
const patch =
  "--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n before\n-old\n+new\n";
Deno.test("native diffs and permission details use protocol file diffs", () => {
  assertEquals(
    mapDiffs([{ file: "example.ts", patch, additions: 1, deletions: 1 }])[0]
      .path,
    "example.ts",
  );
  const request = mapPermission({
    id: "request",
    sessionID: "ses_root",
    permission: "edit",
    patterns: ["example.ts"],
    always: ["*"],
    metadata: { diff: patch },
  }, 10);
  assert(request.detail.kind === "edit" && request.detail.files.length === 1);
});
