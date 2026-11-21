// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createRequestMetadata } from "@otk/protocol";
import { TerminalMux } from "../../../../core/terminals/mux.ts";
import { terminalGroup } from "../../../../core/terminals/ownership.ts";
import type { DaemonConnection } from "../../../../core/terminals/daemon.ts";
import type {
  Frame,
  ProcessInfo,
  Request,
  Response,
} from "../../../../core/terminals/frames.ts";
import { resources, test } from "../../../support/resources.ts";

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!check() && Date.now() < end) await delay(1);
  assert(check(), "mux condition timed out");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
const process: ProcessInfo = {
  id: 1,
  mode: "pty",
  pid: 42,
  command: ["/bin/sh"],
  cwd: "/workspace",
  group_id: terminalGroup({ dir: "/workspace", session: "tstv1-a" }),
  lifecycle: { status: "running" },
  output_head: 0n,
  output_tail: 0n,
  started_at: 1,
  exited_at: null,
  pty: {
    title: "Shell",
    user_title: null,
    foreground_process: "sh",
    cols: 80,
    rows: 24,
  },
};
test("terminal methods contribute metadata through the public protocol composition", () => {
  const metadata = createRequestMetadata();
  assertEquals(metadata.get("terminal.list"), {
    kind: "read",
    pending: "Loading terminals",
  });
  assertEquals(metadata.get("terminal.create"), {
    kind: "mutation",
    pending: "Creating terminal",
  });
  assertEquals(metadata.get("terminal.close"), {
    kind: "mutation",
    pending: "Closing terminal",
  });
});
class Subscription {
  #frames: (Frame | null)[] = [];
  #next?: (frame: Frame | null) => void;
  reads = 0;
  closed = false;
  push(frame: Frame | null): void {
    if (this.#next) {
      const next = this.#next;
      this.#next = undefined;
      next(frame);
    } else this.#frames.push(frame);
  }
  next(): Promise<Frame | null> {
    this.reads++;
    if (this.#frames.length) return Promise.resolve(this.#frames.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#next = resolve);
  }
  close(): void {
    this.closed = true;
    this.push(null);
  }
}
class Socket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  onmessage?: (event: { data: unknown }) => void;
  onclose?: () => void;
  onerror?: () => void;
  sent: (string | Uint8Array)[] = [];
  code?: number;
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.code = code;
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
  receive(data: unknown): void {
    this.onmessage?.({
      data: typeof data === "object" && !(data instanceof ArrayBuffer)
        ? JSON.stringify(data)
        : data,
    });
  }
  controls() {
    return this.sent.filter((v): v is string => typeof v === "string").map((
      v,
    ) => JSON.parse(v));
  }
  attach(ch = 1, terminal = "1"): void {
    this.receive({ t: "attach", ch, session: "tstv1-a", terminal });
  }
}
function attached(): Frame {
  return {
    kind: "json",
    value: {
      type: "attached",
      process,
      role: "observer",
      generation: 1,
      replay_base64: "",
      requested_offset: 0n,
      available_offset: 0n,
      end_offset: 0n,
      truncated: false,
    },
  };
}
function fixture(autoAttach = true) {
  let alive = true;
  let acquisitions = 0;
  const listeners = new Set<() => void>();
  const subscriptions: Subscription[] = [];
  const subscribeRequests: Extract<Request, { op: "subscribe" }>[] = [];
  const requests: Request[] = [];
  let snapshot: Response = {
    type: "snapshot",
    process,
    text: "",
    checkpoint_base64: "",
    cursor_x: 0,
    cursor_y: 0,
  };
  let get: () => Promise<Response> = () =>
    Promise.resolve({ type: "process", process });
  const daemon = {
    get alive() {
      return alive;
    },
    request(request: Request): Promise<Response> {
      requests.push(request);
      if (request.op === "get") return get();
      if (request.op === "snapshot") {
        return Promise.resolve(snapshot);
      }
      return Promise.resolve({ type: "ok" });
    },
    subscribe(
      request: Extract<Request, { op: "subscribe" }>,
    ): Promise<DaemonConnection> {
      subscribeRequests.push(request);
      const subscription = new Subscription();
      subscriptions.push(subscription);
      if (autoAttach) subscription.push(attached());
      return Promise.resolve(subscription as unknown as DaemonConnection);
    },
    release(connection: DaemonConnection): void {
      connection.close();
    },
  };
  const mux = new TerminalMux({
    daemon: () => {
      acquisitions++;
      return Promise.resolve(daemon);
    },
    onGone(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  }, () => Promise.resolve("/workspace"));
  resources().defer("terminal mux", () => mux.stop());
  const socket = new Socket();
  mux.accept(socket as unknown as WebSocket);
  return {
    mux,
    socket,
    subscriptions,
    subscribeRequests,
    requests,
    snapshot: (value: Response) => snapshot = value,
    acquisitions: () => acquisitions,
    get: (run: () => Promise<Response>) => get = run,
    gone() {
      alive = false;
      for (const listener of listeners) listener();
    },
  };
}

for (const missing of [false, true]) {
  test(`subscription EOF confirms ${missing ? "terminated" : "lagging"} with get, never an exit`, async () => {
    const f = fixture();
    f.socket.attach();
    await until(() => f.socket.controls().some((v) => v.t === "meta"));
    if (missing) f.get(() => Promise.reject(new Error("process 1 not found")));
    f.subscriptions[0].push(null);
    await until(() => f.socket.controls().some((v) => v.t === "detached"));
    assertEquals(
      f.socket.controls().find((v) => v.t === "detached").reason,
      missing ? "terminated" : "lagging",
    );
    assertEquals(f.requests.filter((r) => r.op === "get"), [
      { op: "get", id: 1 },
      { op: "get", id: 1 },
    ]);
    assert(!f.socket.controls().some((v) => v.t === "exited"));
  });
}
test("daemon loss closes every relay with gone, not a synthesized exit", async () => {
  const f = fixture(), second = new Socket();
  f.mux.accept(second as unknown as WebSocket);
  f.socket.attach();
  second.attach();
  await until(() => f.subscriptions.length === 2);
  f.gone();
  await f.mux.stop();
  for (const socket of [f.socket, second]) {
    assertEquals(socket.controls().at(-1), { t: "gone" });
    assertEquals(socket.code, 1011);
    assert(!socket.controls().some((v) => v.t === "exited"));
  }
  assert(f.subscriptions.every((s) => s.closed));
});

test("complete raw attach resets once before replay and live bytes without a checkpoint", async () => {
  const f = fixture(false);
  f.socket.attach();
  await until(() => f.subscriptions.length === 1);
  const first = attached();
  assert(first.kind === "json" && first.value.type === "attached");
  first.value.replay_base64 = btoa("primary\x1b[?1049halternate");
  f.subscriptions[0].push(first);
  f.subscriptions[0].push({
    kind: "output",
    start: 30n,
    end: 34n,
    bytes: new TextEncoder().encode("live"),
  });
  await until(() =>
    f.socket.sent.filter((v) => typeof v !== "string").length === 2
  );
  assertEquals(f.subscribeRequests[0].offset, 0n);
  assertEquals(f.requests.some((r) => r.op === "snapshot"), false);
  const snapshots = f.socket.controls().filter((v) => v.t === "snapshot");
  assertEquals(snapshots.length, 1);
  assertEquals(snapshots[0].restore, "replay");
  assertEquals(snapshots[0].checkpoint, "");
  assertEquals(JSON.parse(f.socket.sent[0] as string).t, "snapshot");
  assertEquals(
    f.socket.sent.filter((v): v is Uint8Array => typeof v !== "string").map(
      (v) => new TextDecoder().decode(v.subarray(4)),
    ),
    ["primary\x1b[?1049halternate", "live"],
  );
});

test("truncated raw attach uses checkpoint and fresh tail subscription without leaking partial replay", async () => {
  const f = fixture(false);
  f.snapshot({
    type: "snapshot",
    process: { ...process, output_head: 12n, output_tail: 100n },
    text: "",
    checkpoint_base64: btoa("checkpoint"),
    cursor_x: 0,
    cursor_y: 0,
  });
  f.socket.attach();
  await until(() => f.subscriptions.length === 1);
  const first = attached();
  assert(first.kind === "json" && first.value.type === "attached");
  first.value.truncated = true;
  first.value.available_offset = 12n;
  first.value.replay_base64 = btoa("incomplete");
  f.subscriptions[0].push(first);
  await until(() => f.subscriptions.length === 2);
  const next = attached();
  assert(next.kind === "json" && next.value.type === "attached");
  next.value.replay_base64 = btoa("tail");
  f.subscriptions[1].push(next);
  await until(() => f.socket.sent.some((v) => typeof v !== "string"));
  assert(f.subscriptions[0].closed);
  assertEquals(f.subscribeRequests.map((r) => r.offset), [0n, 100n]);
  assert(
    f.subscribeRequests[0].attachment_id !==
      f.subscribeRequests[1].attachment_id,
  );
  const snapshots = f.socket.controls().filter((v) => v.t === "snapshot");
  assertEquals(snapshots.length, 1);
  assertEquals(snapshots[0].restore, "checkpoint");
  assertEquals(snapshots[0].checkpoint, btoa("checkpoint"));
  assertEquals(
    f.socket.sent.filter((v): v is Uint8Array => typeof v !== "string").map(
      (v) => new TextDecoder().decode(v.subarray(4)),
    ),
    ["tail"],
  );
  assertEquals(f.socket.controls().some((v) => v.t === "detached"), false);
});
test("stop joins a closed relay's pending EOF classification and fences late output", async () => {
  const f = fixture();
  f.socket.attach();
  await until(() => f.socket.controls().some((v) => v.t === "meta"));
  const get = deferred<Response>();
  f.get(() => get.promise);
  f.subscriptions[0].push(null);
  await until(() => f.requests.some((r) => r.op === "get"));
  f.socket.close();
  const count = f.socket.sent.length;
  let stopped = false;
  const stop = f.mux.stop().then(() => stopped = true);
  await delay(10);
  assert(!stopped, "stop must join the already-closed relay");
  get.resolve({ type: "process", process });
  await stop;
  assertEquals(f.socket.sent.length, count);
  assert(f.subscriptions[0].closed);
  const acquisitions = f.acquisitions();
  f.socket.attach(2);
  await delay(10);
  assertEquals(
    f.acquisitions(),
    acquisitions,
    "late messages cannot reacquire a daemon after disposal",
  );
});
test("interaction waits for daemon attachment acknowledgement, not merely subscribe send", async () => {
  const f = fixture(false);
  f.socket.attach();
  await until(() => f.subscriptions.length === 1);
  f.socket.receive({ t: "resize", ch: 1, cols: 100, rows: 30 });
  await delay(10);
  assert(!f.requests.some((r) => r.op === "control" || r.op === "resize"));
  f.subscriptions[0].push(attached());
  await until(() => f.requests.some((r) => r.op === "control"));
});
test("per-channel output budgets pause readers independently while input remains runnable", async () => {
  const f = fixture();
  f.socket.bufferedAmount = 2 * 1024 * 1024;
  f.socket.attach(1, "1");
  f.socket.attach(2, "2");
  await until(() => f.subscriptions.length === 2);
  const noisy = f.subscriptions[0], quiet = f.subscriptions[1];
  for (let i = 0; i < 12; i++) {
    noisy.push({
      kind: "output",
      start: BigInt(i * 65536),
      end: BigInt((i + 1) * 65536),
      bytes: new Uint8Array(65536),
    });
  }
  await until(() => noisy.reads >= 5);
  const paused = noisy.reads;
  await delay(20);
  assertEquals(noisy.reads, paused);
  quiet.push({
    kind: "output",
    start: 0n,
    end: 1n,
    bytes: new Uint8Array([42]),
  });
  await until(() => quiet.reads >= 3);
  const input = new ArrayBuffer(5);
  new DataView(input).setUint32(0, 2);
  new Uint8Array(input)[4] = 65;
  f.socket.receive(input);
  await until(() => f.requests.some((r) => r.op === "input" && r.id === 2));
  assertEquals(f.socket.sent.length, 0, "shared socket remains backpressured");
  f.socket.bufferedAmount = 0;
  await until(() =>
    f.socket.sent.some((v) =>
      typeof v !== "string" && new DataView(v.buffer).getUint32(0) === 2
    )
  );
  for (const ch of [1, 2]) {
    const messages = f.socket.sent.filter((v) =>
      typeof v === "string"
        ? JSON.parse(v).ch === ch
        : new DataView(v.buffer).getUint32(0) === ch
    );
    assertEquals(JSON.parse(messages[0] as string).t, "snapshot");
  }
  assert(
    f.socket.sent.every((v) =>
      typeof v === "string" || v.length <= 16 * 1024 + 4
    ),
  );
});
