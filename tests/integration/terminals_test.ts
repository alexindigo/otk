// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { RequestFailure, SidecarConnection, TerminalSocket } from "@otk/client";
import type { Harness } from "@otk/harness";
import type { ContentSession, TerminalInfo } from "@otk/protocol";
import { startApplication } from "../../application.ts";
import { PtyDaemon, readHandoff } from "../../core/terminals/daemon.ts";
import { embeddedPtyBinary } from "../../core/terminals/binary.ts";
import { bounded, resources, tempDir, test } from "../support/resources.ts";
import { cfg } from "../support/config.ts";
import { originFetch } from "../support/request-wire.ts";

const A = "tstv1-terminal-a", B = "tstv1-terminal-b";
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(
  predicate: () => boolean,
  label: string,
  ms = 5000,
): Promise<void> {
  const end = performance.now() + ms;
  while (!predicate() && performance.now() < end) await delay(2);
  assert(predicate(), label);
}
async function absent(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return false;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return true;
    throw e;
  }
}
async function application(
  options: {
    authenticated?: boolean;
    unavailable?: boolean;
    root?: string;
    failStart?: boolean;
    environment?: Record<string, string>;
  } = {},
) {
  const root = options.root ?? await tempDir("terminal-app-");
  const settings = cfg();
  settings.state.path = join(root, "state");
  settings.server.port = 0;
  settings.auth.type = options.authenticated ? "password" : "none";
  settings.auth.secretkey = "test-terminal-signing-key";
  settings.auth.username = "tester";
  settings.auth.password = "test-only-not-used-to-login";
  const session = (id: string): ContentSession => ({
    id,
    directory: root,
    projectID: "test",
    title: "Terminal test",
    archived: false,
    time: { created: 1, updated: 1 },
  });
  const backend: Harness = {
    capabilities: {},
    core: {
      kind: "external",
      version: "1",
      start(sink) {
        if (options.failStart) {
          return Promise.reject(new Error("terminal-test startup failure"));
        }
        sink.connection("connected");
        sink.indexReset([]);
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
      subscriptions() {},
      identities: (ids) =>
        Promise.resolve(
          ids.filter((id) => id === A || id === B).map((id) => ({
            id,
            directory: root,
          })),
        ),
      getSession: (id) => Promise.resolve(session(id)),
      createSession: () => Promise.resolve(session(A)),
      listChildren: () => Promise.resolve([]),
      listSessions: () =>
        Promise.resolve({ items: [], older: null, generation: "test" }),
      listMessages: () =>
        Promise.reject(new Error("No transcript requested by terminal tests")),
    },
  };
  const environment: Record<string, string> = {
    ...Deno.env.toObject(),
    SHELL: "/bin/bash",
    XDG_DATA_HOME: join(root, "data"),
    ...options.environment,
  };
  delete environment.INVOCATION_ID;
  if (options.unavailable) environment.OTK_PTY_BIN = join(root, "missing-pty");
  const app = await startApplication(
    settings,
    backend,
    fromFileUrl(new URL("../../web/dist/", import.meta.url)),
    { environment },
  );
  const stop = resources().defer(
    "terminal application and handed-off daemon",
    async () => {
      await app.stop();
      const o = {
        runtimeDir: join(settings.state.path, "terminals", "pty"),
        handoffFile: join(settings.state.path, "terminals", "handoff.json"),
        binary: fromFileUrl(embeddedPtyBinary()),
        environment,
        signal: new AbortController().signal,
        systemd: false,
      };
      if (await readHandoff(o)) await (await PtyDaemon.start(o)).shutdown();
    },
  );
  return {
    root,
    settings,
    app,
    stop,
    url: `http://127.0.0.1:${app.server.addr.port}`,
  };
}
async function rpc(url: string) {
  let socket: WebSocket | undefined;
  const conn = new SidecarConnection(url, { status() {}, frame() {} }, {
    fetcher: originFetch(url),
    socket: (address) =>
      socket = Reflect.construct(WebSocket, [address, {
        headers: { Origin: url },
      }]) as WebSocket,
  });
  const stop = resources().defer("main RPC socket", async () => {
    const closed = socket?.readyState === WebSocket.OPEN
      ? new Promise<void>((resolve) =>
        socket!.addEventListener("close", () => resolve(), { once: true })
      )
      : Promise.resolve();
    conn.stop();
    await bounded("main RPC close", closed);
  });
  await conn.connect();
  return { conn, stop };
}
type Control = { t: string; ch?: number; [key: string]: unknown };
class Probe {
  readonly controls: Control[] = [];
  readonly output = new Map<number, string>();
  readonly bytes = new Map<number, number>();
  readonly first = new Map<number, string>();
  readonly closed: Promise<CloseEvent>;
  #decoders = new Map<number, TextDecoder>();
  private constructor(readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    this.closed = new Promise((resolve) =>
      socket.addEventListener("close", resolve, { once: true })
    );
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const control = JSON.parse(event.data) as Control;
        this.controls.push(control);
        if (control.ch && !this.first.has(control.ch)) {
          this.first.set(control.ch, control.t);
        }
        if (control.t === "ping") this.send({ t: "pong" });
      } else {
        const frame = new Uint8Array(event.data),
          ch = new DataView(frame.buffer).getUint32(0, false);
        if (!this.first.has(ch)) this.first.set(ch, "bytes");
        let decoder = this.#decoders.get(ch);
        if (!decoder) this.#decoders.set(ch, decoder = new TextDecoder());
        this.output.set(
          ch,
          ((this.output.get(ch) ?? "") +
            decoder.decode(frame.subarray(4), { stream: true })).slice(-32768),
        );
        this.bytes.set(ch, (this.bytes.get(ch) ?? 0) + frame.length - 4);
      }
    });
  }
  static async open(url: string): Promise<Probe> {
    const socket = Reflect.construct(WebSocket, [
      url.replace("http:", "ws:") + "/api/terminal",
      { headers: { Origin: url } },
    ]) as WebSocket;
    const probe = new Probe(socket);
    resources().defer("terminal WebSocket", () => probe.stop());
    await bounded(
      "terminal socket open",
      new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = reject;
      }),
    );
    return probe;
  }
  send(message: Control): void {
    this.socket.send(JSON.stringify(message));
  }
  input(ch: number, text: string): void {
    const bytes = new TextEncoder().encode(text),
      frame = new Uint8Array(4 + bytes.length);
    new DataView(frame.buffer).setUint32(0, ch, false);
    frame.set(bytes, 4);
    this.socket.send(frame);
  }
  async attach(ch: number, terminal: string, session = A): Promise<void> {
    this.send({ t: "attach", ch, session, terminal });
    await this.control("snapshot", ch);
    await until(
      () =>
        this.controls.some((c) =>
          c.t === "meta" && c.ch === ch && c.role === "observer"
        ),
      "observer attached",
    );
    assertEquals(this.first.get(ch), "snapshot");
  }
  async control(t: string, ch?: number): Promise<Control> {
    await until(
      () => this.controls.some((c) => c.t === t && c.ch === ch),
      `${t} on ${ch}`,
    );
    return this.controls.find((c) => c.t === t && c.ch === ch)!;
  }
  async text(ch: number, expected: string, ms = 5000): Promise<void> {
    try {
      await until(
        () =>
          (this.output.get(ch) ?? "").replace(
            // deno-lint-ignore no-control-regex -- Strip actual VT control sequences, not printable command text.
            /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g,
            "",
          ).replaceAll("\r", "").includes(expected.replaceAll("\r", "")),
        `${ch}: ${expected}; got ${this.output.get(ch)}`,
        ms,
      );
    } catch (cause) {
      console.info(
        JSON.stringify({
          ch,
          output: this.output.get(ch),
          controls: this.controls,
        }),
      );
      throw cause;
    }
  }
  async stop(): Promise<void> {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
    await bounded("terminal socket close", this.closed);
  }
}

test("real application terminal RPC and shared socket: isolation, observer, resize, fairness, query reply and close", async () => {
  const app = await application(), client = await rpc(app.url);
  const call = client.conn.rpc.call.bind(client.conn.rpc);
  assertEquals(await call("terminal.list", { sessionID: A }), []);
  const a = await call("terminal.create", { sessionID: A, cols: 80, rows: 24 });
  const b = await call("terminal.create", { sessionID: A, cols: 80, rows: 24 });
  assertEquals(
    (await call("terminal.list", { sessionID: A })).map((p: TerminalInfo) =>
      p.id
    ),
    [a.id, b.id],
  );
  const socket = await Probe.open(app.url);
  await socket.attach(1, a.id);
  await socket.attach(2, b.id);
  socket.input(1, "echo pilot-$((6*7))\r");
  await socket.text(1, "\r\npilot-42\r\n");
  assert(!(socket.output.get(2) ?? "").includes("pilot-42"));
  socket.send({ t: "resize", ch: 1, cols: 100, rows: 30 });
  const resized = await socket.control("resized", 1);
  assertEquals([resized.cols, resized.rows], [100, 30]);
  assert(typeof resized.checkpoint === "string");
  const observer = await Probe.open(app.url);
  await observer.attach(1, a.id);
  socket.input(1, "echo observer-$((7*7))\r");
  await Promise.all([
    socket.text(1, "\r\nobserver-49\r\n"),
    observer.text(1, "\r\nobserver-49\r\n"),
  ]);
  assert(!observer.controls.some((c) => c.role === "controller"));
  const noisyRelease = join(app.root, "fairness-release");
  socket.input(
    2,
    `while [ ! -e '${noisyRelease}' ]; do printf 'noisy-active\\n'; done; seq 1 2000000\r`,
  );
  await until(() => (socket.bytes.get(2) ?? 0) > 100000, "noisy output active");
  const started = performance.now();
  socket.input(1, "echo fair\r");
  await socket.text(1, "\r\nfair\r\n", 500);
  const fairnessLatencyMs = performance.now() - started;
  assert(fairnessLatencyMs < 500);
  await Deno.writeTextFile(noisyRelease, "");
  await socket.text(2, "\r\n2000000\r\n", 60000);
  assert(!(socket.output.get(1) ?? "").includes("\r\n2000000\r\n"));
  console.info(
    JSON.stringify({
      fairnessLatencyMs,
      noisyLastLine: 2000000,
      noisyBytes: socket.bytes.get(2),
    }),
  );
  // Only the daemon supplies the cursor-position reply. No browser input is
  // generated by this probe, and the shell consumes one complete reply.
  socket.input(
    1,
    "stty -echo; printf '\\033[6n'; IFS= read -r -d R -t 2 reply; stty echo; printf '\\nDSR:%sR\\n' \"$reply\"\r",
  );
  await until(
    // deno-lint-ignore no-control-regex -- Assert the daemon's actual ESC-prefixed cursor reply.
    () => /DSR:\x1b\[[0-9]+;[0-9]+R/.test(socket.output.get(1) ?? ""),
    "daemon cursor response",
  );
  socket.input(1, "echo intact-$((8*8))\r");
  await socket.text(1, "\r\nintact-64\r\n");
  const pongs =
    observer.controls.filter((control) => control.t === "pong").length;
  observer.send({ t: "detach", ch: 1 });
  observer.send({ t: "ping" });
  await until(
    () =>
      observer.controls.filter((control) => control.t === "pong").length >
        pongs,
    "post-detach socket barrier",
  );
  const marker = `after-detach-${crypto.randomUUID()}`;
  socket.input(1, `printf '\\n${marker}\\n'\r`);
  await socket.text(1, `\r\n${marker}\r\n`);
  assert(!(observer.output.get(1) ?? "").includes(marker));
  await observer.attach(2, a.id);
  await call("terminal.close", { sessionID: A, terminalID: a.id });
  assertEquals((await socket.control("detached", 1)).reason, "terminated");
  assertEquals((await observer.control("detached", 2)).reason, "terminated");
  assert(!socket.controls.some((c) => c.t === "exited" && c.ch === 1));
  assert(!observer.controls.some((c) => c.t === "exited" && c.ch === 2));
  assertEquals(
    (await call("terminal.list", { sessionID: A })).map((p: TerminalInfo) =>
      p.id
    ),
    [b.id],
  );
  socket.input(2, "exit 3\r");
  assertEquals((await socket.control("exited", 2)).exitCode, 3);
  await call("terminal.close", { sessionID: A, terminalID: b.id });
  assertEquals(await call("terminal.list", { sessionID: A }), []);
  await socket.stop();
  await observer.stop();
  await client.stop();
  await app.stop();
});

test("terminal admission: auth and Origin precede daemon access; unavailable RPC is typed", async () => {
  const app = await application({ authenticated: true });
  for (
    const [origin, status] of [[app.url, 401], [
      "http://foreign.invalid",
      403,
    ]] as const
  ) {
    const response = await fetch(app.url + "/api/terminal", {
      headers: { Upgrade: "websocket", Origin: origin },
    });
    assertEquals(response.status, status);
    await response.body?.cancel();
  }
  assert(await absent(join(app.settings.state.path, "terminals")));
  const unavailable = await application({ unavailable: true }),
    client = await rpc(unavailable.url);
  for (const method of ["terminal.list", "terminal.create"] as const) {
    const failure = await assertRejects(
      () => client.conn.rpc.call(method, { sessionID: A, cols: 80, rows: 24 }),
      RequestFailure,
    );
    assertEquals(failure.failure.code, "terminal-unavailable");
  }
  const health = await fetch(unavailable.url + "/api/health");
  assertEquals(health.status, 200);
  await health.body?.cancel();
});

test("terminal attachment desired dimensions reach the actual PTY after initial open and reconnect", async () => {
  const app = await application(), client = await rpc(app.url);
  const terminal = await client.conn.rpc.call("terminal.create", {
    sessionID: A,
    cols: 80,
    rows: 24,
  });
  let current!: WebSocket, connected = false, output = "";
  const transport = new TerminalSocket({
    base: new URL(app.url + "/api/"),
    options: {
      socket: (url) =>
        current = Reflect.construct(WebSocket, [url, {
          headers: { Origin: app.url },
        }]) as WebSocket,
    },
  });
  resources().defer("stop size transport", () => transport.stop());
  const attachment = transport.attach(A, terminal.id, {
    reset() {
      output = "";
    },
    resize() {},
    write(bytes) {
      output += new TextDecoder().decode(bytes);
    },
    meta(value) {
      if (value.connected !== undefined) connected = value.connected;
    },
  });
  const lines = () =>
    output.replace(
      // deno-lint-ignore no-control-regex -- Match shell output, not VT mode changes around stty.
      /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g,
      "",
    ).replaceAll("\r", "").split("\n");
  attachment.resize(111, 37);
  await until(() => connected, "initial size attachment");
  attachment.input(new TextEncoder().encode("stty size\r"));
  await until(
    () => lines().includes("37 111"),
    "shell sees initial desired size",
  );
  current.close();
  await until(() => !connected, "size transport disconnected");
  attachment.resize(132, 48);
  await until(() => connected, "size transport reattached");
  attachment.input(new TextEncoder().encode("stty size\r"));
  await until(
    () => lines().includes("48 132"),
    "shell sees disconnected desired size",
  );
});

test("invalid terminal cache configuration preserves application availability", async () => {
  const app = await application({
    environment: { HOME: "relative", XDG_DATA_HOME: "relative" },
  });
  const health = await fetch(app.url + "/api/health");
  assertEquals(health.status, 200);
  await health.body?.cancel();
  const client = await rpc(app.url);
  const failure = await assertRejects(
    () => client.conn.rpc.call("terminal.list", { sessionID: A }),
    RequestFailure,
  );
  assertEquals(failure.failure.code, "terminal-unavailable");
});

test("terminal socket validates membership, channel count and policy limits", async () => {
  const app = await application(), client = await rpc(app.url);
  const a = await client.conn.rpc.call("terminal.create", {
    sessionID: A,
    cols: 80,
    rows: 24,
  });
  const socket = await Probe.open(app.url);
  socket.send({ t: "attach", ch: 1, session: B, terminal: a.id });
  assertEquals((await socket.control("error", 1)).code, "not-found");
  const wrongClose = await assertRejects(
    () =>
      client.conn.rpc.call("terminal.close", {
        sessionID: B,
        terminalID: a.id,
      }),
    RequestFailure,
  );
  assertEquals(wrongClose.failure.code, "not-found");
  socket.send({ t: "attach", ch: 2, session: A, terminal: "999999" });
  assertEquals((await socket.control("error", 2)).code, "not-found");
  for (let ch = 3; ch < 19; ch++) await socket.attach(ch, a.id);
  socket.send({ t: "attach", ch: 19, session: A, terminal: a.id });
  assertEquals((await socket.control("error", 19)).code, "too-many");
  socket.socket.send(new Uint8Array(65537));
  assertEquals((await bounded("input policy close", socket.closed)).code, 1008);
  for (
    const message of [
      "x".repeat(4097),
      JSON.stringify({
        t: "attach",
        ch: 1,
        session: "tstv1-" + "a".repeat(512),
        terminal: a.id,
      }),
      JSON.stringify({ t: "attach", ch: 0, session: A, terminal: a.id }),
    ]
  ) {
    const invalid = await Probe.open(app.url);
    invalid.socket.send(message);
    assertEquals(
      (await bounded("control policy close", invalid.closed)).code,
      1008,
    );
  }
  const reused = await Probe.open(app.url);
  await reused.attach(1, a.id);
  reused.send({ t: "detach", ch: 1 });
  reused.send({ t: "attach", ch: 1, session: A, terminal: a.id });
  assertEquals(
    (await bounded("channel reuse close", reused.closed)).code,
    1008,
  );
});

test("application teardown hands terminals to the next real application composition", async () => {
  const app = await application(), client = await rpc(app.url);
  const a = await client.conn.rpc.call("terminal.create", {
    sessionID: A,
    cols: 80,
    rows: 24,
  });
  const socket = await Probe.open(app.url);
  await socket.attach(1, a.id);
  socket.input(1, "echo retained-$((9*9))\r");
  await socket.text(1, "\r\nretained-81\r\n");
  // Stop only the application here; the fixture's final disposer reclaims and
  // destroys the test-owned daemon after the survival assertion.
  await app.app.stop();
  assertEquals(
    (await bounded("application closes live terminal socket", socket.closed))
      .code,
    1001,
  );
  await client.stop();
  const next = await application({ root: app.root }),
    nextClient = await rpc(next.url);
  assertEquals(
    (await nextClient.conn.rpc.call("terminal.list", { sessionID: A })).map((
      p: TerminalInfo,
    ) => p.id),
    [a.id],
  );
  const attached = await Probe.open(next.url);
  await attached.attach(1, a.id);
  const snapshot = await attached.control("snapshot", 1);
  assert(
    typeof snapshot.checkpoint === "string" && snapshot.checkpoint.length > 0,
  );
  attached.input(1, "echo reclaimed-$((9*10))\r");
  await attached.text(1, "\r\nreclaimed-90\r\n");
  await nextClient.conn.rpc.call("terminal.close", {
    sessionID: A,
    terminalID: a.id,
  });
});

test("application startup failure does not dispose core-owned storage twice", async () => {
  const failure = await assertRejects(
    () => application({ failStart: true }),
    Error,
    "terminal-test startup failure",
  );
  assert(
    !(failure instanceof AggregateError),
    "startup cleanup must retain the original cause without duplicate storage disposal",
  );
});
