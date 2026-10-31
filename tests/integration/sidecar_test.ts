// SPDX-License-Identifier: LGPL-3.0-only
import { resources, test } from "../support/resources.ts";
import { serve } from "../support/http.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { ContentSession, Message } from "@otk/protocol";
import type { IndexEntry } from "@otk/protocol";
import { markdown } from "@otk/content";
import { FakeLlm } from "../support/fake-llm.ts";
import { freePort, OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { ownSocket, WsClient } from "../support/ws-client.ts";
import { FreezeProxy } from "../support/freeze-proxy.ts";
// @deno-types="npm:@types/ws@8.18.1"
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@otk/protocol";
import { readRpcMessages } from "../support/message-pages.ts";
import type { MessagePage } from "@otk/protocol";
import { HttpRequests, RequestFailure } from "@otk/client";
import { originFetch } from "../support/request-wire.ts";

test("I11 message paging retains opaque native continuation and exact-multiple terminal pages", async () => {
  const f = await fixture();
  try {
    const server = await f.sidecar(), client = await f.client(server);
    const welcome = await client.wait((frame) => frame.t === "welcome");
    assert(welcome.t === "welcome");
    assert(welcome.sidecar.harness.capabilities);
    assertEquals([...welcome.sidecar.harness.capabilities].sort(), [
      "agents",
      "commands",
      "digests",
      "files",
      "history",
      "models",
      "permissions",
      "prompt",
      "questions",
      "resources",
      "restore",
      "revert",
      "sessionActions",
      "shell",
      "usage",
    ]);
    const session = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Paging",
    });
    for (let i = 0; i < 30; i++) {
      await f.oc.request(`/session/${session.id}/message`, {
        method: "POST",
        body: { noReply: true, parts: [{ type: "text", text: `Prompt ${i}` }] },
      });
    }
    const newest = await client.rpc<MessagePage>("session.messages", {
      sessionID: session.id,
    });
    assertEquals(newest.items.length, 10);
    assert(newest.older && newest.older !== newest.items[0].id);
    const older = await client.rpc<MessagePage>("session.messages", {
      sessionID: session.id,
      before: newest.older,
    });
    assertEquals(older.items.length, 10);
    assert(
      older.items[0].parts.some((part) =>
        part.kind === "text" &&
        JSON.stringify(part.blocks).includes("Prompt 10")
      ),
    );
    assert(older.older);
    const first = await client.rpc<MessagePage>("session.messages", {
      sessionID: session.id,
      before: older.older,
    });
    assertEquals(first.items.length, 10);
    assertEquals(first.older, null);
    assertEquals(
      new Set(
        [...first.items, ...older.items, ...newest.items].map((m) => m.id),
      ).size,
      30,
    );
  } finally {
    await f.stop();
  }
});

function latest(client: WsClient, id: string): IndexEntry | undefined {
  return client.entry(id);
}
async function fixture() {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const clients: WsClient[] = [], sidecars: SidecarTest[] = [];
  return {
    fake,
    oc,
    async sidecar(overrides: Parameters<typeof SidecarTest.start>[1] = {}) {
      const server = await SidecarTest.start(oc, overrides);
      sidecars.push(server);
      return server;
    },
    async client(server: SidecarTest, cookie?: string) {
      const client = new WsClient(server.url, cookie);
      clients.push(client);
      await client.connect();
      await client.wait((frame) =>
        frame.t === "harness" && frame.state === "connected"
      );
      return client;
    },
    async stop() {
      for (const client of clients) await client.close();
      for (const server of sidecars) await server.stop();
      await oc.stop();
      await fake.stop();
    },
  };
}
const reply =
  "# Streaming\n\nAn incremental reply.\n\n- first\n- second\n\n```ts\nconst otk = 1;\n```\n";
const script = () => ({
  chunks: Array.from({ length: 20 }, (_, i) =>
    reply.slice(
      Math.floor(i * reply.length / 20),
      Math.floor((i + 1) * reply.length / 20),
    )),
  delay: 50,
});
async function prompt(
  client: WsClient,
  session: ContentSession,
  text = "OTK test",
) {
  client.send({ t: "subscribe", sessionID: session.id });
  await client.rpc("session.prompt", {
    sessionID: session.id,
    mode: "normal",
    parts: [{ kind: "text", text }],
  });
}
async function completed(client: WsClient, id: string): Promise<Message[]> {
  await waitFor(
    () => latest(client, id),
    (entry) =>
      entry?.status === "idle" && entry.timeUpdated > entry.timeCreated,
    60_000,
  );
  return waitFor(
    () => readRpcMessages(client, id),
    (messages) =>
      messages.some((m) =>
        m.role === "assistant" && m.time.completed !== undefined
      ),
    60_000,
  );
}

test("I1 startup catalogue exposes existing idle sessions", async () => {
  const f = await fixture();
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Existing" },
    });
    const server = await f.sidecar(), client = await f.client(server);
    await waitFor(
      () => client.entry(session.id),
      (entry) => entry?.status === "idle",
    );
  } finally {
    await f.stop();
  }
});
test("I2 streaming blocks, busy/idle index, final history and adapter boundary", async () => {
  const f = await fixture();
  try {
    const server = await f.sidecar(), client = await f.client(server);
    const session = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Streaming",
    });
    f.fake.queue(script());
    await prompt(client, session);
    await client.wait((frame) =>
      frame.t === "index.patch" &&
      frame.ops.some((op) =>
        op.op === "upsert" && op.entry.id === session.id &&
        op.entry.status === "busy"
      )
    );
    const history = await completed(client, session.id);
    const ops = client.frames.flatMap((frame) =>
      frame.t === "content" && frame.sessionID === session.id
        ? [frame.event]
        : []
    );
    const deltas = ops.filter((op) => op.op === "part.blocks");
    assert(
      deltas.length >= 3,
      `Expected incremental ops: ${server.log}\n${f.oc.log}`,
    );
    let prior = 0;
    for (const op of deltas) {
      if (op.op === "part.blocks") {
        assert(op.from >= prior);
        prior = op.from;
      }
    }
    const final = ops.findLast((op) =>
      op.op === "part.upsert" && op.part.kind === "text"
    );
    assert(final?.op === "part.upsert" && final.part.kind === "text");
    // JSON frames omit optional undefined fields; compare the one-shot model in
    // the same wire representation the consumer actually receives.
    assertEquals(
      final.part.blocks,
      JSON.parse(JSON.stringify(markdown(reply))),
    );
    const part = history.flatMap((m) => m.parts).find((part) =>
      part.kind === "text" &&
      JSON.stringify(part.blocks) === JSON.stringify(markdown(reply))
    );
    assert(part, JSON.stringify(history));
    assert(!JSON.stringify(ops).includes('"metadata"'));
    assert(!JSON.stringify(ops).includes('"state"'));
  } finally {
    await f.stop();
  }
});
test("I3 unsubscribed client receives index but no content", async () => {
  const f = await fixture();
  try {
    const server = await f.sidecar(),
      client = await f.client(server),
      observer = await f.client(server);
    const session = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Subscription",
    });
    f.fake.queue(script());
    await prompt(client, session);
    await completed(client, session.id);
    assert(observer.frames.some((frame) => frame.t === "index.patch"));
    assert(!observer.frames.some((frame) => frame.t === "content"));
  } finally {
    await f.stop();
  }
});
test("I4 bash permission round trip and completed typed output", async () => {
  const f = await fixture();
  try {
    const server = await f.sidecar(), client = await f.client(server);
    const session = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Permission",
    });
    f.fake.queue({
      tool: {
        name: "bash",
        input: { command: "echo otk", description: "probe" },
      },
    }, { chunks: ["Permission completed"] });
    await prompt(client, session);
    const frame = await client.wait((frame) =>
      frame.t === "content" && frame.event.op === "permission.upsert"
    );
    assert(frame.t === "content" && frame.event.op === "permission.upsert");
    const request = frame.event.request;
    assert(
      request.detail.kind === "bash" && request.detail.command === "echo otk",
    );
    await waitFor(
      () => latest(client, session.id),
      (entry) => entry?.attention.permissions === 1,
    );
    await client.rpc("permission.reply", {
      requestID: request.id,
      sessionID: request.sessionID,
      reply: "once",
    });
    await waitFor(
      () => latest(client, session.id),
      (entry) => entry?.attention.permissions === 0,
    );
    await client.wait(
      (frame) =>
        frame.t === "content" && frame.event.op === "part.upsert" &&
        frame.event.part.kind === "tool" &&
        frame.event.part.call.tool === "bash" &&
        frame.event.part.call.status === "completed" &&
        frame.event.part.call.output.includes("otk"),
      60_000,
    );
  } finally {
    await f.stop();
  }
});
test("I5 child permission rolls up to root", async () => {
  const f = await fixture();
  try {
    const server = await f.sidecar(), client = await f.client(server);
    const root = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Parent",
    });
    f.fake.queue(
      {
        tool: {
          name: "task",
          input: {
            subagent_type: "general",
            description: "OTK child permission probe",
            prompt: "Run the scripted bash probe",
          },
        },
      },
      {
        tool: {
          name: "bash",
          input: { command: "echo otk", description: "child probe" },
        },
      },
      { chunks: ["Child completed"] },
      { chunks: ["Parent completed"] },
    );
    await prompt(client, root);
    const children = await waitFor(
      () => f.oc.sessionList<{ id: string }>(`/session/${root.id}/children`),
      (children) => children.length > 0,
      60_000,
    );
    const child = children[0];
    const requests = await waitFor(
      () => f.oc.request<{ id: string; sessionID: string }[]>("/permission"),
      (requests) =>
        requests.some((request) => request.sessionID === child.nativeID),
      60_000,
    );
    const request = requests.find((request) =>
      request.sessionID === child.nativeID
    )!;
    await waitFor(
      () => latest(client, root.id),
      (entry) => entry?.attention.childPermissions === 1,
    );
    await client.rpc("permission.reply", {
      sessionID: child.id,
      requestID: request.id,
      reply: "once",
    });
    await waitFor(
      () => latest(client, root.id),
      (entry) => entry?.attention.childPermissions === 0,
    );
  } finally {
    await f.stop();
  }
});
test("I6 silent drop recovers idle snapshot, resync and complete reply", async () => {
  const f = await fixture(), proxy = new FreezeProxy(f.oc.port);
  try {
    const server = await f.sidecar({
        harness: {
          url: `http://127.0.0.1:${proxy.port}`,
          db: f.oc.db,
          heartbeattimeout: 2,
        },
      }),
      client = await f.client(server);
    const session = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Silent drop",
    });
    f.fake.queue(script());
    await prompt(client, session);
    await client.wait((frame) =>
      frame.t === "content" && frame.event.op === "part.blocks"
    );
    const baseline = client.frames.length;
    proxy.freeze();
    await client.wait((frame) =>
      frame.t === "harness" && frame.state === "reconnecting"
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    proxy.thaw();
    await waitFor(
      () => ({
        entry: client.entry(session.id),
        connected: client.frames.slice(baseline).some((frame) =>
          frame.t === "harness" && frame.state === "connected"
        ),
        resync: client.frames.slice(baseline).some((frame) =>
          frame.t === "bootstrap.complete"
        ),
      }),
      (value) =>
        value.entry?.status === "idle" && value.connected && value.resync,
      30_000,
    );
    assert(
      client.frames.slice(baseline).some((frame) =>
        frame.t === "bootstrap.complete"
      ),
    );
    const history = await readRpcMessages(client, session.id);
    assert(
      history.flatMap((m) => m.parts).some((part) =>
        part.kind === "text" &&
        JSON.stringify(part.blocks) === JSON.stringify(markdown(reply))
      ),
    );
  } finally {
    await proxy.stop();
    await f.stop();
  }
});
test("I7 opencode restart reconnects and reconciles existing indexed sessions", async () => {
  const f = await fixture();
  try {
    const server = await f.sidecar(), client = await f.client(server);
    const session = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Restarted index",
    });
    await waitFor(
      () => client.entry(session.id),
      (entry) => entry?.status === "idle",
    );
    const baseline = client.frames.length;
    await f.oc.restart();
    await client.wait((frame) =>
      frame.t === "harness" && frame.state === "reconnecting"
    );
    await waitFor(
      () => ({
        entry: client.entry(session.id),
        connected: client.frames.slice(baseline).some((frame) =>
          frame.t === "harness" && frame.state === "connected"
        ),
        resync: client.frames.slice(baseline).some((frame) =>
          frame.t === "bootstrap.complete"
        ),
      }),
      (value) =>
        value.entry?.id === session.id && value.entry.status === "idle" &&
        value.connected && value.resync,
    );
  } finally {
    await f.stop();
  }
});
test("I8 compatible idle projects bootstrap without loading native inventories", async () => {
  const f = await fixture(), controller = new AbortController();
  const requests: { path: string; directory: string | null }[] = [];
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      assertEquals(request.method, "GET");
      requests.push({
        path: url.pathname,
        directory: url.searchParams.get("directory"),
      });
      return fetch(new URL(url.pathname + url.search, f.oc.url), {
        headers: request.headers,
        signal: controller.signal,
      });
    },
  );
  try {
    const second = join(f.oc.root, "second");
    await Deno.mkdir(second);
    const directories = [f.oc.directory, second];
    const sessions: { id: string }[] = [];
    for (const directory of [...directories, f.oc.directory]) {
      sessions.push(
        await f.oc.session<{ id: string }>("/session", {
          method: "POST",
          directory,
          body: { title: "Idle" },
        }),
      );
    }
    const server = await f.sidecar({
        harness: { url: `http://127.0.0.1:${proxy.addr.port}`, db: f.oc.db },
      }),
      client = await f.client(server);
    const entries = await waitFor(
      () => sessions.map((session) => client.entry(session.id)),
      (entries) => entries.every((entry) => entry !== undefined),
    );
    for (const session of sessions) {
      const entry = entries.find((entry) => entry?.id === session.id)!;
      assertEquals(entry.status, "idle");
      assertEquals([
        entry.attention.permissions,
        entry.attention.questions,
        entry.attention.childPermissions,
        entry.attention.childQuestions,
      ], [0, 0, 0, 0]);
    }
    const inventories = ["/session/status", "/permission", "/question"];
    assertEquals(
      requests.filter(({ path }) => inventories.includes(path))
        .map(({ path, directory }) => [directory, path]),
      [],
    );
  } finally {
    try {
      await f.stop();
    } finally {
      controller.abort();
      await proxy.shutdown();
    }
  }
});
test("I9 password cookie, WS authentication, Origin, logout and CORS", async () => {
  const f = await fixture();
  try {
    const extraOrigin = "http://127.0.0.1:31502";
    const server = await f.sidecar({
      server: { port: freePort(), origins: [extraOrigin] },
      auth: {
        type: "password",
        username: "tester",
        password: "secret",
        secretkey: "01234567890123456789012345678901",
      },
    });
    const unauthenticated = await fetch(server.url + "/api/ws", {
      headers: { Origin: server.url },
    });
    assertEquals(unauthenticated.status, 401);
    await unauthenticated.text();
    const rejected = await fetch(server.url + "/api/login", {
      method: "POST",
      headers: {
        Origin: "https://foreign",
        "Content-Type": "application/json",
      },
      body: '{"username":"tester","password":"secret"}',
    });
    assertEquals(rejected.status, 403);
    await rejected.text();
    const transport = (origin: string, cookie?: string) => {
      const responses: Response[] = [];
      const fetcher = originFetch(origin);
      const http = new HttpRequests({
        base: new URL(server.url + "/api/"),
        fetcher: async (input, options) => {
          const headers = new Headers(options?.headers);
          if (cookie) headers.set("Cookie", cookie);
          const response = await fetcher(input, { ...options, headers });
          responses.push(response);
          return response;
        },
      });
      resources().defer("authenticated HTTP client", () => http.stop());
      return { http, responses };
    };
    const sameOrigin = transport(server.url);
    assertEquals(
      await sameOrigin.http.start("login", {
        username: "tester",
        password: "secret",
      }).result,
      { ok: true },
    );
    assertEquals(sameOrigin.responses[0].status, 202);
    assertEquals(sameOrigin.responses[0].headers.get("set-cookie"), null);
    const login = sameOrigin.responses.at(-1)!;
    assertEquals(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert(cookie.startsWith(`otk_${server.port}=`));
    assert(cookie.includes("HttpOnly") && cookie.includes("SameSite=Strict"));
    const preflight = await fetch(server.url + "/api/login", {
      method: "OPTIONS",
      headers: {
        Origin: extraOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    assertEquals(preflight.status, 204);
    assertEquals(
      preflight.headers.get("access-control-allow-origin"),
      extraOrigin,
    );
    assertEquals(
      preflight.headers.get("access-control-allow-credentials"),
      "true",
    );
    assert(
      preflight.headers.get("access-control-allow-methods")!.includes("POST"),
    );
    await preflight.text();
    const crossOrigin = transport(extraOrigin);
    assertEquals(
      await crossOrigin.http.start("login", {
        username: "tester",
        password: "secret",
      }).result,
      { ok: true },
    );
    assertEquals(crossOrigin.responses[0].status, 202);
    const crossOriginLogin = crossOrigin.responses.at(-1)!;
    assertEquals(crossOriginLogin.status, 200);
    assertEquals(
      crossOriginLogin.headers.get("access-control-allow-origin"),
      extraOrigin,
    );
    assertEquals(
      crossOriginLogin.headers.get("access-control-allow-credentials"),
      "true",
    );
    const incorrect = transport(extraOrigin);
    const failure = await assertRejects(
      () =>
        incorrect.http.start("login", {
          username: "tester",
          password: "incorrect",
        }).result,
      RequestFailure,
    );
    assertEquals(failure.failure.code, "credentials");
    assertEquals(incorrect.responses[0].status, 202);
    const incorrectCredentials = incorrect.responses.at(-1)!;
    assertEquals(incorrectCredentials.status, 200);
    assertEquals(incorrectCredentials.headers.get("set-cookie"), null);
    assertEquals(
      incorrectCredentials.headers.get("access-control-allow-origin"),
      extraOrigin,
    );
    await f.client(server, cookie.split(";")[0]);
    const authenticated = transport(server.url, cookie.split(";")[0]);
    assertEquals(
      await authenticated.http.start("logout", {}).result,
      { ok: true },
    );
    assertEquals(authenticated.responses[0].status, 202);
    const logout = authenticated.responses.at(-1)!;
    assertEquals(logout.status, 200);
    assert(logout.headers.get("set-cookie")!.includes("Max-Age=0"));
  } finally {
    await f.stop();
  }
});
test("I14 a server.origins override keeps the fixture's own port and applies the origin", async () => {
  const f = await fixture();
  try {
    const extraOrigin = "http://127.0.0.1:31503";
    const server = await f.sidecar({ server: { origins: [extraOrigin] } });
    assert(
      server.port !== 1502,
      `sidecar landed on default port ${server.port}`,
    );
    assertEquals(server.url, `http://127.0.0.1:${server.port}`);
    const preflight = await fetch(server.url + "/api/login", {
      method: "OPTIONS",
      headers: {
        Origin: extraOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    assertEquals(preflight.status, 204);
    assertEquals(
      preflight.headers.get("access-control-allow-origin"),
      extraOrigin,
    );
    await preflight.text();
  } finally {
    await f.stop();
  }
});
test("I10 total sidecar RSS stays within 1 GiB after a complete 2 MB reply", async () => {
  const f = await fixture();
  try {
    const server = await f.sidecar(), client = await f.client(server);
    const session = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Footprint",
    });
    f.fake.queue({ chunks: ["start", ...Array(20).fill("x")], delay: 50 });
    await prompt(client, session);
    await client.wait((frame) =>
      frame.t === "content" && frame.event.op === "part.blocks"
    );
    client.send({ t: "unsubscribe", sessionID: session.id });
    await completed(client, session.id);
    const baseline = await server.rssKiB();
    const limitKiB = 1024 * 1024;
    assert(
      baseline <= limitKiB,
      `Baseline total RSS ${baseline} KiB exceeds ${limitKiB} KiB`,
    );
    const big = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Large reply",
    });
    f.fake.queue({ chunks: ["x".repeat(2 * 1024 * 1024)], delay: 10 });
    await prompt(client, big);
    await client.wait((frame) =>
      frame.t === "content" && frame.sessionID === big.id &&
      frame.event.op === "message.upsert" &&
      frame.event.message.role === "assistant" &&
      frame.event.message.time.completed !== undefined
    );
    const history = await completed(client, big.id);
    assert(
      history.some((message) =>
        message.parts.some((part) =>
          part.kind === "text" &&
          part.blocks.some((block) =>
            block.b === "paragraph" && block.inline.some((item) =>
              item.i === "text" && item.text.length === 2 * 1024 * 1024
            )
          )
        )
      ),
      "Consumer did not receive the complete 2 MB reply",
    );
    // Measure settled idle RSS, not V8's temporary allocation high-water mark.
    // Fixed delay: no inspector, forced GC, allocator overrides or polling for a pass.
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    const after = await server.rssKiB();
    console.info(
      `sidecar total RSS (35 s settled idle): baseline=${baseline} KiB, idle=${after} KiB, limit=${limitKiB} KiB, growth=${
        after - baseline
      } KiB`,
    );
    assert(
      after <= limitKiB,
      `Idle total RSS ${after} KiB exceeds ${limitKiB} KiB`,
    );
  } finally {
    await f.stop();
  }
});

test("I12 JSON heartbeat pings every 20 seconds, retains pong clients and closes silence at 60", async () => {
  const f = await fixture();
  let silent: WebSocket | undefined;
  try {
    const server = await f.sidecar(), client = await f.client(server);
    const started = performance.now(), pings: number[] = [];
    silent = new WebSocket(server.url.replace(/^http/, "ws") + "/api/ws", {
      headers: { Origin: server.url },
    });
    ownSocket(silent);
    const socket = silent;
    const closed = new Promise<
      { elapsed: number; code: number; reason: string }
    >((resolve) => {
      socket.once(
        "close",
        (code, reason) =>
          resolve({
            elapsed: performance.now() - started,
            code,
            reason: reason.toString(),
          }),
      );
    });
    socket.on("message", (data) => {
      if (JSON.parse(data.toString()).t === "ping") {
        pings.push(performance.now() - started);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }));
    const result = await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Silent client did not close")),
          65_000,
        );
        closed.then(() => clearTimeout(timer));
      }),
    ]);
    assert(
      result.elapsed >= 59_000 && result.elapsed < 64_000,
      JSON.stringify(result),
    );
    assertEquals(result.code, 1001);
    assertEquals(result.reason, "heartbeat timeout");
    assert(pings.length >= 2, JSON.stringify(pings));
    assert(pings[0] >= 19_000 && pings[0] < 21_000, JSON.stringify(pings));
    for (let i = 1; i < pings.length; i++) {
      assert(
        pings[i] - pings[i - 1] >= 19_000 && pings[i] - pings[i - 1] < 21_000,
        JSON.stringify(pings),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    assertEquals(client.ws.readyState, WebSocket.OPEN);
    assert(client.frames.filter((frame) => frame.t === "ping").length >= 3);
    console.info(
      `JSON heartbeat: pings=${
        JSON.stringify(pings)
      }, silent close=${result.elapsed} ms; pong client open past 60 s`,
    );
  } finally {
    if (silent && silent.readyState !== WebSocket.CLOSED) silent.terminate();
    await f.stop();
  }
});
