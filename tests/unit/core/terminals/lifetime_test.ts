// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DaemonConnection,
  PtyDaemon,
  readHandoff,
} from "../../../../core/terminals/daemon.ts";
import type { Frame, Request } from "../../../../core/terminals/frames.ts";
import {
  bounded,
  resources,
  tempDir,
  test,
} from "../../../support/resources.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
class Connection {
  closed = false;
  sent: Request[] = [];
  incoming = deferred<Frame | null>();
  writing = Promise.resolve();
  send(_token: string, request: Request): Promise<void> {
    this.sent.push(request);
    return this.writing;
  }
  response() {
    return Promise.resolve({ type: "owned" as const });
  }
  next() {
    return this.incoming.promise;
  }
  close() {
    this.closed = true;
    this.incoming.resolve(null);
  }
  get port() {
    return this as unknown as DaemonConnection;
  }
}
async function fixture() {
  const root = await tempDir("pty-lifetime-"), name = "otk-pty-test";
  const runtimeDir = join(root, "runtime"),
    handoffFile = join(root, "handoff.json");
  await Deno.mkdir(join(runtimeDir, name), { recursive: true });
  await Deno.writeTextFile(
    join(runtimeDir, name, "service.json"),
    JSON.stringify({
      instance_id: "test",
      pid: 1,
      protocol: 8,
      features: [],
      socket: join(root, "socket"),
      token: "test-token",
    }),
  );
  await Deno.writeTextFile(
    handoffFile,
    JSON.stringify({
      name,
      runtimeDir,
      ticket: "ticket",
      expiresAt: Date.now() + 10000,
    }),
  );
  const owner = new Connection();
  const original = DaemonConnection.connect;
  let connect: () => Promise<DaemonConnection> = () =>
    Promise.resolve(owner.port);
  DaemonConnection.connect = () => connect();
  resources().defer("restore connection factory", () => {
    DaemonConnection.connect = original;
  });
  const daemon = await PtyDaemon.start({
    binary: "/bin/false",
    runtimeDir,
    handoffFile,
    environment: {},
    systemd: false,
    signal: new AbortController().signal,
  });
  resources().defer("disconnect owner", () => daemon.disconnect());
  return {
    daemon,
    owner,
    connect: (factory: typeof connect) => {
      connect = factory;
    },
  };
}
const subscription = {
  op: "subscribe",
  id: 1,
  offset: 0n,
  attachment_id: "a",
  role: "observer",
  takeover: false,
} as const;
for (const kind of ["request", "subscribe"] as const) {
  test(`owner loss fences a pending ${kind} acquisition before sending`, async () => {
    const f = await fixture(),
      connected = deferred<DaemonConnection>(),
      next = new Connection();
    f.connect(() => connected.promise);
    const pending = kind === "request"
      ? f.daemon.request({ op: "list", mode: "pty" })
      : f.daemon.subscribe(subscription);
    // Attach the rejection handler before releasing the acquisition.
    const rejected = assertRejects(() => pending);
    await f.daemon.disconnect();
    connected.resolve(next.port);
    await bounded("pending acquisition rejected", rejected);
    assertEquals(next.closed, true);
    assertEquals(next.sent, []);
  });
}
test("owner loss retires a subscription whose write is pending", async () => {
  const f = await fixture(),
    writing = deferred<void>(),
    next = new Connection();
  next.writing = writing.promise;
  f.connect(() => Promise.resolve(next.port));
  const pending = f.daemon.subscribe(subscription);
  const outcome = pending.then(() => "attached", () => "rejected");
  await Promise.resolve();
  await f.daemon.disconnect();
  writing.resolve();
  assertEquals(await outcome, "rejected");
  assertEquals(next.closed, true);
});

test("pre-send acquisition failure has definite no-effect identity", async () => {
  const f = await fixture();
  await f.daemon.disconnect();
  const error = await assertRejects(
    () => f.daemon.request({ op: "list", mode: "pty" }),
    Error,
  );
  assertEquals(error.name, "DaemonNotSentError");
});

test("owner reply rejection is observed while its send is pending", async () => {
  const f = await fixture(), writing = deferred<void>();
  f.owner.writing = writing.promise;
  const unhandled: unknown[] = [];
  const observe = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", observe);
  resources().defer(
    "restore rejection observer",
    () => globalThis.removeEventListener("unhandledrejection", observe),
  );
  const rejected = assertRejects(() => f.daemon.handoff());
  await Promise.resolve();
  await f.daemon.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  writing.resolve();
  await rejected;
  assertEquals(unhandled, []);
});

test("handoff expiry is decided by the daemon's monotonic clock", async () => {
  const root = await tempDir("handoff-clock-"),
    handoffFile = join(root, "handoff.json");
  const value = {
    name: "otk-pty-test",
    runtimeDir: root,
    ticket: "ticket",
    expiresAt: 1,
  };
  await Deno.writeTextFile(handoffFile, JSON.stringify(value));
  assertEquals(await readHandoff({ handoffFile, runtimeDir: root }), value);
});
