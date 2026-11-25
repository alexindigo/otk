// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { PtyDaemon } from "../../../../core/terminals/daemon.ts";
import type { Request } from "../../../../core/terminals/frames.ts";
import {
  bounded,
  resources,
  tempDir,
  test,
} from "../../../support/resources.ts";

async function fixture() {
  const root = await tempDir("pty-q-");
  const name = "otk-pty-test",
    runtimeDir = join(root, "r"),
    handoffFile = join(root, "h.json"),
    path = join(root, "q.sock");
  await Deno.mkdir(join(runtimeDir, name), { recursive: true });
  await Deno.writeTextFile(
    join(runtimeDir, name, "service.json"),
    JSON.stringify({
      instance_id: "test",
      pid: 1,
      protocol: 8,
      features: [],
      socket: path,
      token: "test-token",
    }),
  );
  await Deno.writeTextFile(
    handoffFile,
    JSON.stringify({
      name,
      runtimeDir,
      ticket: "test-ticket",
      expiresAt: Date.now() + 10000,
    }),
  );
  const listener = Deno.listen({ transport: "unix", path });
  const connections = new Set<Deno.UnixConn>(),
    handlers: Promise<void>[] = [],
    observed: Request[] = [];
  let first!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => first = resolve),
    gate = new Promise<void>((resolve) => release = resolve);
  async function read(conn: Deno.UnixConn): Promise<Request | null> {
    const header = new Uint8Array(4);
    let count = 0;
    while (count < 4) {
      const n = await conn.read(header.subarray(count));
      if (n === null) return null;
      count += n;
    }
    const body = new Uint8Array(new DataView(header.buffer).getUint32(0));
    count = 0;
    while (count < body.length) {
      const n = await conn.read(body.subarray(count));
      if (n === null) return null;
      count += n;
    }
    const envelope = JSON.parse(new TextDecoder().decode(body));
    assertEquals(envelope.token, "test-token");
    return envelope.request;
  }
  async function reply(conn: Deno.UnixConn, value: unknown): Promise<void> {
    const body = new TextEncoder().encode(JSON.stringify(value)),
      frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length);
    frame.set(body, 4);
    let n = 0;
    while (n < frame.length) n += await conn.write(frame.subarray(n));
  }
  async function handle(conn: Deno.UnixConn): Promise<void> {
    try {
      const request = await read(conn);
      if (!request) return;
      if (request.op === "own") {
        assertEquals(request.ticket, "test-ticket");
        await reply(conn, { type: "owned" });
        const stop = await read(conn);
        if (stop) {
          assertEquals(stop.op, "shutdown");
          await reply(conn, { type: "ok" });
        }
      } else {
        observed.push(request);
        if (request.op === "input" && observed.length === 1) {
          first();
          await gate;
        }
        await reply(conn, { type: "ok" });
        // Returning closes this connection: reusing it would fail the next call.
      }
    } catch (error) {
      if (
        !(error instanceof Deno.errors.BadResource ||
          error instanceof Deno.errors.BrokenPipe ||
          error instanceof Deno.errors.ConnectionReset)
      ) throw error;
    } finally {
      connections.delete(conn);
      try {
        conn.close();
      } catch { /* already closed by cleanup */ }
    }
  }
  const accepting = (async () => {
    try {
      for await (const conn of listener) {
        connections.add(conn);
        const handling = handle(conn);
        void handling.catch(() => {});
        handlers.push(handling);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  })();
  resources().defer("join fake daemon", async () => {
    release();
    listener.close();
    for (const conn of connections) conn.close();
    await accepting;
    await Promise.all(handlers);
  });
  const daemon = await PtyDaemon.start({
    binary: "/bin/false",
    runtimeDir,
    handoffFile,
    environment: {},
    systemd: false,
    signal: new AbortController().signal,
  });
  resources().defer("stop queue owner", () => daemon.shutdown());
  const input = (text: string, signal?: AbortSignal): Promise<unknown> =>
    Reflect.apply(daemon.request, daemon, [{
      op: "input",
      id: 1,
      attachment_id: "a",
      cols: 80,
      rows: 24,
      data_base64: encodeBase64(text),
    }, signal]);
  return { daemon, input, started, release, observed };
}

test("ordinary requests are one-shot, ordered per terminal, coalesced and independent", async () => {
  const { daemon, input, started, release, observed } = await fixture();
  const a = input("A");
  await bounded(
    "first queue request",
    Promise.race([
      started,
      a.then(() => {
        throw new Error("First input completed before its gate");
      }),
    ]),
  );
  const b = input("B"), c = input("C");
  const resize = daemon.request({
    op: "resize",
    id: 1,
    attachment_id: "a",
    cols: 90,
    rows: 30,
  });
  const d = input("D");
  assertEquals((await daemon.request({ op: "get", id: 2 })).type, "ok");
  assertEquals(
    observed.length,
    2,
    "terminal 2 completed while terminal 1 was held",
  );
  release();
  await Promise.all([a, b, c, resize, d]);
  const ordered = observed.filter((r) => "id" in r && r.id === 1);
  assertEquals(ordered.map((r) => r.op), ["input", "input", "resize", "input"]);
  assertEquals(
    ordered.filter((r) => r.op === "input").map((r) =>
      new TextDecoder().decode(decodeBase64(r.data_base64))
    ),
    ["A", "BC", "D"],
  );
  assert(
    ordered.every((r) =>
      r.op !== "input" || decodeBase64(r.data_base64).length <= 65536
    ),
  );
});

test("daemon ingress rejects a backlog beyond the transport's high-water window", async () => {
  const f = await fixture();
  const outcomes: string[] = [];
  const work = Array.from(
    { length: 17 },
    () =>
      f.input("x".repeat(65536)).then(
        () => outcomes.push("sent"),
        () => outcomes.push("rejected"),
      ),
  );
  await bounded("first input admitted", f.started);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(
    outcomes.includes("rejected"),
    "a 1 MiB transport window cannot retain seventeen 64 KiB requests",
  );
  f.release();
  await Promise.all(work);
});

test("cancellation retires queued input before the active request completes", async () => {
  const f = await fixture();
  const a = f.input("A");
  void a.catch(() => {});
  await bounded(
    "first input admitted",
    Promise.race([
      f.started,
      a.then(() => {
        throw new Error("First input completed before its gate");
      }),
    ]),
  );
  const abort = new AbortController();
  const rejected = assertRejects(() => f.input("B", abort.signal));
  abort.abort();
  await bounded("cancel queued input", rejected, 1000);
  f.release();
  await a;
  assertEquals(
    f.observed.filter((r) => r.op === "input").map((r) =>
      new TextDecoder().decode(decodeBase64(r.data_base64))
    ),
    ["A"],
  );
});

test("cancelling coalesced input preserves another caller's queued bytes", async () => {
  const f = await fixture();
  const a = f.input("A");
  void a.catch(() => {});
  await bounded("first input admitted", f.started);
  const abort = new AbortController();
  const b = assertRejects(() => f.input("B", abort.signal));
  const c = assertRejects(() => f.input("C", abort.signal));
  const d = f.input("D", new AbortController().signal);
  void d.catch(() => {});
  abort.abort();
  await bounded("coalesced cancellation", Promise.all([b, c]));
  f.release();
  await Promise.all([a, d]);
  assertEquals(
    f.observed.filter((request) => request.op === "input").map((request) =>
      new TextDecoder().decode(decodeBase64(request.data_base64))
    ),
    ["A", "D"],
  );
});
