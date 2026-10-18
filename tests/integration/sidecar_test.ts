// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ContentSession, Message } from "@otk/protocol";
import type { IndexEntry } from "@otk/protocol";
import { markdown } from "@otk/content";
import { FakeLlm } from "../support/fake-llm.ts";
import { freePort, OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
import { FreezeProxy } from "../support/freeze-proxy.ts";
// @deno-types="npm:@types/ws@8.18.1"
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@otk/protocol";

Deno.test("I11 message paging accepts OTK message IDs without leaking harness cursors", async () => {
  const f = await fixture();
  try {
    const server = await f.sidecar(), client = await f.client(server);
    const welcome = await client.wait((frame) => frame.t === "welcome");
    assert(welcome.t === "welcome");
    assert(welcome.sidecar.harness.capabilities);
    assertEquals([...welcome.sidecar.harness.capabilities].sort(), [
      "agents",
      "commands",
      "files",
      "history",
      "models",
      "permissions",
      "prompt",
      "questions",
      "resources",
      "revert",
      "shell",
    ]);
    const session = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Paging",
    });
    for (const text of ["First", "Middle", "Last"]) {
      await f.oc.request(`/session/${session.id}/message`, {
        method: "POST",
        body: { noReply: true, parts: [{ type: "text", text }] },
      });
    }
    const newest = await client.rpc<Message[]>("session.messages", {
      sessionID: session.id,
      limit: 1,
    });
    assertEquals(newest.length, 1);
    const older = await client.rpc<Message[]>("session.messages", {
      sessionID: session.id,
      limit: 1,
      before: newest[0].id,
    });
    assertEquals(older.length, 1);
    assert(
      older[0].parts.some((part) =>
        part.kind === "text" && JSON.stringify(part.blocks).includes("Middle")
      ),
    );
    const first = await client.rpc<Message[]>("session.messages", {
      sessionID: session.id,
      limit: 1,
      before: older[0].id,
    });
    const empty = await client.rpc<Message[]>("session.messages", {
      sessionID: session.id,
      limit: 1,
      before: first[0].id,
    });
    assertEquals(empty, []);
  } finally {
    await f.stop();
  }
});

function latest(client: WsClient, id: string): IndexEntry | undefined {
  let entry: IndexEntry | undefined;
  for (const frame of client.frames) {
    if (frame.t === "index.snapshot") {
      entry = frame.entries.find((e) => e.id === id);
    }
    if (frame.t === "index.patch") {
      for (const op of frame.ops) {
        if (op.op === "upsert" && op.entry.id === id) entry = op.entry;
        else if (op.op === "remove" && op.id === id) entry = undefined;
      }
    }
  }
  return entry;
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
    () =>
      client.rpc<Message[]>("session.messages", { sessionID: id, limit: 100 }),
    (messages) =>
      messages.some((m) =>
        m.role === "assistant" && m.time.completed !== undefined
      ),
    60_000,
  );
}

Deno.test("I1 startup snapshot includes existing idle sessions", async () => {
  const f = await fixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Existing" },
    });
    const server = await f.sidecar(), client = await f.client(server);
    await client.wait((frame) =>
      frame.t === "index.snapshot" &&
      frame.entries.some((entry) =>
        entry.id === session.id && entry.status === "idle"
      )
    );
  } finally {
    await f.stop();
  }
});
Deno.test("I2 streaming blocks, busy/idle index, final history and adapter boundary", async () => {
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
Deno.test("I3 unsubscribed client receives index but no content", async () => {
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
Deno.test("I4 bash permission round trip and completed typed output", async () => {
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
Deno.test("I5 child permission rolls up to root", async () => {
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
      () => f.oc.request<{ id: string }[]>(`/session/${root.id}/children`),
      (children) => children.length > 0,
      60_000,
    );
    const child = children[0];
    const requests = await waitFor(
      () => f.oc.request<{ id: string; sessionID: string }[]>("/permission"),
      (requests) => requests.some((request) => request.sessionID === child.id),
      60_000,
    );
    const request = requests.find((request) => request.sessionID === child.id)!;
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
Deno.test("I6 silent drop recovers idle snapshot, resync and complete reply", async () => {
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
      () => client.frames.slice(baseline),
      (frames) =>
        frames.some((frame) =>
          frame.t === "index.snapshot" &&
          frame.entries.some((entry) =>
            entry.id === session.id && entry.status === "idle"
          )
        ),
      30_000,
    );
    assert(client.frames.slice(baseline).some((frame) => frame.t === "resync"));
    const history = await client.rpc<Message[]>("session.messages", {
      sessionID: session.id,
      limit: 100,
    });
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
Deno.test("I7 opencode restart reconnects and resnapshots", async () => {
  const f = await fixture();
  try {
    const server = await f.sidecar(), client = await f.client(server);
    const baseline = client.frames.length;
    await f.oc.restart();
    await client.wait((frame) =>
      frame.t === "harness" && frame.state === "reconnecting"
    );
    await waitFor(
      () => client.frames.slice(baseline),
      (frames) =>
        frames.some((frame) => frame.t === "index.snapshot") &&
        frames.some((frame) => frame.t === "resync"),
    );
  } finally {
    await f.stop();
  }
});
Deno.test("I8 bootstrap makes no instance queries for idle projects", async () => {
  const f = await fixture(), proxy = new FreezeProxy(f.oc.port);
  try {
    const second = join(f.oc.root, "second");
    await Deno.mkdir(second);
    const sessions: { id: string }[] = [];
    for (const directory of [f.oc.directory, second]) {
      sessions.push(
        await f.oc.request<{ id: string }>("/session", {
          method: "POST",
          directory,
          body: { title: "Idle" },
        }),
      );
    }
    const server = await f.sidecar({
        harness: { url: `http://127.0.0.1:${proxy.port}`, db: f.oc.db },
      }),
      client = await f.client(server);
    await client.wait((frame) =>
      frame.t === "index.snapshot" &&
      sessions.every((session) =>
        frame.entries.some((entry) => entry.id === session.id)
      )
    );
    assert(
      !proxy.requests.some((request) =>
        /^GET \/(session\/status|permission|question)(\?| )/.test(request)
      ),
      JSON.stringify(proxy.requests),
    );
  } finally {
    await proxy.stop();
    await f.stop();
  }
});
Deno.test("I9 password cookie, WS authentication, Origin, logout and CORS", async () => {
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
    const login = await fetch(server.url + "/api/login", {
      method: "POST",
      headers: { Origin: server.url, "Content-Type": "application/json" },
      body: '{"username":"tester","password":"secret"}',
    });
    assertEquals(login.status, 200);
    await login.json();
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
    const crossOriginLogin = await fetch(server.url + "/api/login", {
      method: "POST",
      headers: { Origin: extraOrigin, "Content-Type": "application/json" },
      body: '{"username":"tester","password":"secret"}',
    });
    assertEquals(crossOriginLogin.status, 200);
    assertEquals(
      crossOriginLogin.headers.get("access-control-allow-origin"),
      extraOrigin,
    );
    assertEquals(
      crossOriginLogin.headers.get("access-control-allow-credentials"),
      "true",
    );
    await crossOriginLogin.json();
    const incorrectCredentials = await fetch(server.url + "/api/login", {
      method: "POST",
      headers: { Origin: extraOrigin, "Content-Type": "application/json" },
      body: '{"username":"tester","password":"incorrect"}',
    });
    assertEquals(incorrectCredentials.status, 401);
    assertEquals(
      incorrectCredentials.headers.get("access-control-allow-origin"),
      extraOrigin,
    );
    await incorrectCredentials.json();
    await f.client(server, cookie.split(";")[0]);
    const logout = await fetch(server.url + "/api/logout", {
      method: "POST",
      headers: { Origin: server.url, Cookie: cookie.split(";")[0] },
    });
    assertEquals(logout.status, 200);
    await logout.json();
    assert(logout.headers.get("set-cookie")!.includes("Max-Age=0"));
  } finally {
    await f.stop();
  }
});
Deno.test("I10 total sidecar RSS stays within 1 GiB after a complete 2 MB reply", async () => {
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

Deno.test("I12 JSON heartbeat pings every 20 seconds, retains pong clients and closes silence at 60", async () => {
  const f = await fixture();
  let silent: WebSocket | undefined;
  try {
    const server = await f.sidecar(), client = await f.client(server);
    const started = performance.now(), pings: number[] = [];
    silent = new WebSocket(server.url.replace(/^http/, "ws") + "/api/ws", {
      headers: { Origin: server.url },
    });
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
