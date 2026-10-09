// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { authenticator } from "otplib";
import { Lexer } from "marked";
import { encodeBase32 } from "@std/encoding/base32";
import { cfg, fixture } from "../support/config.ts";
import {
  hashPassword,
  LocalAuth,
  verifyPassword,
} from "../../sidecar/auth/local.ts";
import { allowedOrigin } from "../../sidecar/auth/middleware.ts";
import { AuthState } from "../../sidecar/auth/state.ts";
import { IndexStore } from "../../sidecar/index/store.ts";
import { Backoff, Watchdog } from "../../sidecar/adapter/opencode1/watchdog.ts";
import { consumeEvents } from "../../sidecar/adapter/opencode1/events.ts";
import {
  mapDiffs,
  mapIndex,
  mapMessage,
  mapPart,
  mapPermission,
} from "../../sidecar/adapter/opencode1/map.ts";
import { blocks, markdown } from "../../sidecar/content/markdown.ts";
import { parseDiff } from "../../sidecar/content/diff.ts";
import { StreamingMarkdown } from "../../sidecar/content/stream.ts";
import type { Block } from "../../protocol/content.ts";
import type { ServerFrame } from "../../protocol/messages.ts";
const session = {
  id: "ses_root",
  projectID: "project",
  directory: "/project",
  title: "Root",
  time: { created: 1, updated: 2 },
};

Deno.test("PBKDF2 round-trip, incorrect password and malformed digest", async () => {
  const hash = await hashPassword("test-password");
  assert(await verifyPassword("test-password", hash));
  assert(!await verifyPassword("wrong", hash));
  assert(!await verifyPassword("test-password", "pbkdf2_sha256$0$00$00"));
});
Deno.test("JWT expiry and identity validation", async () => {
  const settings = {
    ...cfg().auth,
    type: "password",
    username: "Tester",
    password: "password",
    secretkey: "01234567890123456789012345678901",
  };
  let now = Date.now();
  const auth = new LocalAuth(settings, () => now),
    token = await auth.login("tester", "password");
  await auth.validateToken(token);
  now += 31 * 86_400_000;
  await assertRejects(() => auth.validateToken(token));
  await assertRejects(() => auth.login("another", "password"));
});
Deno.test("TOTP accepts adjacent time window and rejects replay", async () => {
  const now = 1_791_360_000_000,
    settings = {
      ...cfg().auth,
      type: "totp",
      username: "tester",
      password: "password",
      secretkey: "01234567890123456789012345678901",
      totpkey: "OTK test seed",
    };
  const otp = authenticator.clone();
  otp.options = { epoch: now - 30_000 };
  const code = otp.generate(
    encodeBase32(new TextEncoder().encode(settings.totpkey)).replace(/=+$/, ""),
  );
  const auth = new LocalAuth(settings, () => now);
  await auth.login("tester", "password" + code);
  await assertRejects(() => auth.login("tester", "password" + code));
});
Deno.test("Origin rejects missing, foreign and null even in none mode", () => {
  const settings = cfg();
  settings.auth.type = "none";
  settings.server.origins = ["https://remote"];
  for (const origin of [undefined, "null", "https://foreign"]) {
    assert(
      !allowedOrigin(
        new Request("http://127.0.0.1:1502/api/ws", {
          headers: origin ? { Origin: origin } : {},
        }),
        settings,
      ),
    );
  }
  assert(
    allowedOrigin(
      new Request("http://127.0.0.1:1502/api/ws", {
        headers: { Origin: "http://127.0.0.1:1502" },
      }),
      settings,
    ),
  );
  assert(
    allowedOrigin(
      new Request("http://127.0.0.1:1502/api/ws", {
        headers: { Origin: "https://remote" },
      }),
      settings,
    ),
  );
});
Deno.test("setup stores hashed password and private state, refuses repeat", async () => {
  const settings = cfg();
  settings.state.path = join(await fixture(), "private");
  const auth = new AuthState(settings);
  await auth.setup({
    type: "password",
    username: "Tester",
    password: "secret",
  });
  const stored = await Deno.readTextFile(
    join(settings.state.path, "auth.toml"),
  );
  assert(!stored.includes('password = "secret"'));
  assert(stored.includes("pbkdf2_sha256"));
  assertEquals((await Deno.stat(settings.state.path)).mode! & 0o777, 0o700);
  assertEquals(
    (await Deno.stat(join(settings.state.path, "auth.toml"))).mode! & 0o777,
    0o600,
  );
  await assertRejects(() => auth.setup({ type: "none" }));
});
Deno.test("index coalesces mutations, revisions and reset invalidates pending patches", async () => {
  const store = new IndexStore(), frames: ServerFrame[] = [];
  store.listen((frame) => frames.push(frame));
  store.upsert(mapIndex(session));
  store.upsert(mapIndex({ ...session, title: "Updated" }));
  await Promise.resolve();
  assertEquals(frames.length, 1);
  assertEquals(frames[0].t, "index.patch");
  assertEquals(store.rev, 2);
  store.remove(session.id);
  store.reset([mapIndex(session)]);
  await Promise.resolve();
  assertEquals(frames.length, 2);
  assertEquals(frames[1].t, "index.snapshot");
});
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
  assert(generic.kind === "tool" && generic.call.tool === "generic");
  assertEquals(generic.call.output?.length, 65_536);
});
const patch =
  "--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n before\n-old\n+new\n";
Deno.test("diff conversion preserves hunk line numbers and add/delete/rename status", () => {
  const [diff] = parseDiff(patch);
  assertEquals(diff.additions, 1);
  assertEquals(diff.deletions, 1);
  assertEquals(diff.hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo]), [
    ["context", 1, 1],
    ["del", 2, undefined],
    ["add", undefined, 2],
  ]);
  assertEquals(
    parseDiff(patch.replace("b/example.ts", "b/moved.ts"))[0].status,
    "moved",
  );
  const [added] = parseDiff(
    "--- /dev/null\n+++ b/added.ts\n@@ -0,0 +1,1 @@\n+new\n",
  );
  assertEquals([added.path, added.status, added.additions, added.deletions], [
    "added.ts",
    "added",
    1,
    0,
  ]);
  const [deleted] = parseDiff(
    "--- a/deleted.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\n",
  );
  assertEquals([
    deleted.path,
    deleted.status,
    deleted.additions,
    deleted.deletions,
  ], ["deleted.ts", "deleted", 0, 1]);
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
Deno.test("markdown maps every block and inline shape and represents HTML as text", () => {
  const content = markdown(
    "# Heading\n\n**bold** *em* ~~deleted~~ `code` [link](https://example.com) ![alt](https://example.com/a.png)  \nnext\n\n> quote\n\n- [x] done\n- item\n\n|A|B|\n|:-|--:|\n|one|two|\n\n---\n\n```ts\nconst x=1;\n```\n\n<script>alert(1)</script>\n",
  );
  assertEquals(content.map((b) => b.b), [
    "heading",
    "paragraph",
    "quote",
    "list",
    "table",
    "rule",
    "code",
    "paragraph",
  ]);
  assert(JSON.stringify(content).includes("<script>"));
  assert(content[1].b === "paragraph");
  const kinds = content[1].inline.map((i) => i.i);
  for (
    const kind of ["strong", "em", "del", "code", "link", "image", "break"]
  ) assert(kinds.includes(kind as typeof kinds[number]));
});
Deno.test("markdown preserves Marked setext grammar and long plain paragraphs", () => {
  const text = "x".repeat(2 * 1024 * 1024);
  assertEquals(markdown(text), [{
    b: "paragraph",
    inline: [{ i: "text", text }],
  }]);
  for (
    const source of [
      "Heading\n===\n",
      "Heading\n  ---  \n",
      "Heading\n-",
      "Heading\n=",
      "First\nsecond\n---\n\nDone",
      "Heading\n    ---\n",
      "Heading\n--- extra\n",
      "- list\n  continuation\n",
      "# ATX\n\nparagraph\n",
      "|A|B|\n|--|--|\n|one|two|\n",
      "```\nHeading\n---\n```\n",
      "> Heading\n> ===\n",
    ]
  ) assertEquals(markdown(source), blocks(Lexer.lex(source, { gfm: true })));
});
Deno.test("stream tail equals one-shot parse for 20 random chunkings and late references", () => {
  const texts = [
    "# Heading\n\nWords\n\n- first\n- second\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone.",
    "[later][ref]\n\nNext\n\n[ref]: https://example.com\n",
    "# Windows\r\n\r\nText\r\n\r\n```ts\r\nlet x = 1;\r\n```\r\n",
  ];
  for (const text of texts) {
    for (let seed = 1; seed <= 20; seed++) {
      const stream = new StreamingMarkdown();
      let received: Block[] = [], offset = 0, random = seed, prior = 0;
      while (offset < text.length) {
        random = (random * 1664525 + 1013904223) >>> 0;
        const count = 1 + random % 13;
        stream.append(text.slice(offset, offset + count));
        offset += count;
        const op = stream.flush();
        assert(op.from >= prior);
        prior = op.from;
        received = [...received.slice(0, op.from), ...op.blocks];
        assertEquals(received, markdown(stream.text));
      }
      assertEquals(received, markdown(text));
    }
  }
});
