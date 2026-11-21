// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createState,
  type Rpc,
  SessionTerminals,
  type SidecarConnection,
  type StateFactory,
  type TerminalClock,
  type TerminalMeta,
  type TerminalSink,
  TerminalSocket,
} from "@otk/client";
import type { TerminalInfo } from "@otk/protocol";

class Clock implements TerminalClock {
  time = 0;
  next = 0;
  jobs = new Map<number, { at: number; run: () => void }>();
  now = () => this.time;
  schedule(run: () => void, ms: number): () => void {
    const id = ++this.next;
    this.jobs.set(id, { at: this.time + ms, run });
    return () => {
      this.jobs.delete(id);
    };
  }
  tick(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const entry = [...this.jobs].filter(([, j]) =>
        j.at <= end
      ).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) {
        break;
      }
      this.time = entry[1].at;
      this.jobs.delete(entry[0]);
      entry[1].run();
    }
    this.time = end;
  }
}
class Socket {
  readyState: number = WebSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: (string | Uint8Array)[] = [];
  closed = 0;
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed++;
    this.readyState = WebSocket.CLOSED;
  }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
  fail(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
  message(data: object): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  bytes(ch: number, text: string): void {
    this.onmessage?.({
      data: frame(ch, new TextEncoder().encode(text)).buffer,
    });
  }
  controls(t?: string): Record<string, unknown>[] {
    return this.sent.filter((v): v is string => typeof v === "string").map((
      v,
    ) => JSON.parse(v)).filter((v) => !t || v.t === t);
  }
  snapshot(ch: number, checkpoint = "screen"): void {
    this.message({
      t: "snapshot",
      ch,
      cols: 80,
      rows: 24,
      checkpoint: btoa(checkpoint),
      title: "shell",
      foreground: null,
      status: "running",
    });
  }
}
function frame(ch: number, bytes: Uint8Array): Uint8Array {
  const value = new Uint8Array(4 + bytes.length);
  new DataView(value.buffer).setUint32(0, ch, false);
  value.set(bytes, 4);
  return value;
}
function sink() {
  const events: unknown[] = [], metas: TerminalMeta[] = [];
  return {
    events,
    metas,
    reset: (cols: number, rows: number, bytes: Uint8Array) => {
      events.push(["reset", cols, rows, [...bytes]]);
    },
    resize: (cols: number, rows: number) => {
      events.push(["resize", cols, rows]);
    },
    write: (bytes: Uint8Array) => {
      events.push(["write", [...bytes]]);
    },
    meta: (change: TerminalMeta) => {
      metas.push(change);
    },
  } satisfies TerminalSink & { events: unknown[]; metas: TerminalMeta[] };
}
const info = (id: string): TerminalInfo => ({
  id,
  title: "shell",
  foreground: null,
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  startedAt: 1,
});
function fixture(base = "http://otk.test/mount/api/") {
  const sockets: Socket[] = [], urls: string[] = [], clock = new Clock();
  const calls: { method: string; params: unknown; signal?: AbortSignal }[] = [];
  let list = Array.from({ length: 6 }, (_, i) => info(String(i + 1)));
  let read: ((signal?: AbortSignal) => Promise<TerminalInfo[]>) | undefined;
  const conn = {
    base: new URL(base),
    options: {
      socket(url: URL) {
        urls.push(url.href);
        const s = new Socket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    },
    rpc: {
      call(
        method: string,
        params: { terminalID?: string },
        signal?: AbortSignal,
      ) {
        calls.push({ method, params, signal });
        if (method === "terminal.list") {
          return read?.(signal) ?? Promise.resolve(list.map((v) => ({ ...v })));
        }
        if (method === "terminal.create") {
          const next = info("7");
          list = [...list, next];
          return Promise.resolve(next);
        }
        list = list.filter((v) => v.id !== params.terminalID);
        return Promise.resolve(null);
      },
    } as unknown as Rpc,
  } satisfies Pick<SidecarConnection, "base" | "options" | "rpc">;
  const socket = new TerminalSocket(conn, clock);
  return {
    conn,
    socket,
    sockets,
    urls,
    clock,
    calls,
    setList: (v: TerminalInfo[]) => {
      list = v;
    },
    setRead: (v: typeof read) => {
      read = v;
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

Deno.test("latest desired size survives delayed open and disconnected resize without extra reset", () => {
  const f = fixture(), target = sink();
  try {
    const attachment = f.socket.attach("tstv1-a", "1", target);
    attachment.resize(100, 30);
    f.clock.tick(500);
    const first = f.sockets[0];
    first.open();
    attachment.resize(120, 40);
    assertEquals(first.controls("resize"), []);
    first.snapshot(1);
    assertEquals(first.controls("resize"), [{
      t: "resize",
      ch: 1,
      cols: 120,
      rows: 40,
    }]);
    first.bytes(1, "replay");
    first.message({ t: "resized", ch: 1, cols: 120, rows: 40 });
    assertEquals(
      target.events.filter((e) => (e as unknown[])[0] === "reset").length,
      1,
    );
    first.fail();
    attachment.resize(140, 50);
    f.clock.tick(1000);
    const second = f.sockets[1];
    second.open();
    second.snapshot(1);
    assertEquals(second.controls("resize"), [{
      t: "resize",
      ch: 1,
      cols: 140,
      rows: 50,
    }]);
    second.message({ t: "detached", ch: 1, reason: "lagging" });
    attachment.resize(150, 55);
    second.snapshot(2);
    assertEquals(second.controls("resize").at(-1), {
      t: "resize",
      ch: 2,
      cols: 150,
      rows: 55,
    });
  } finally {
    f.socket.stop();
  }
});

Deno.test("silent OPEN transport expires after 45 s; incoming frames renew it and idle/stop release deadlines", () => {
  const f = fixture(), target = sink();
  try {
    const attachment = f.socket.attach("tstv1-a", "1", target);
    const first = f.sockets[0];
    first.open();
    first.snapshot(1);
    f.clock.tick(44_999);
    assertEquals(first.closed, 0);
    first.message({ t: "ping" });
    f.clock.tick(44_999);
    assertEquals(first.closed, 0);
    f.clock.tick(1);
    assertEquals(first.closed, 1);
    assertEquals(target.metas.at(-1), { connected: false });
    f.clock.tick(1000);
    assertEquals(f.sockets.length, 2);
    f.sockets[1].open();
    f.sockets[1].snapshot(1);
    attachment.close();
    // No liveness timer while no attachment needs the transport.
    assertEquals(f.clock.jobs.size, 1);
    f.clock.tick(60_000);
    assertEquals(f.clock.jobs.size, 0);
    f.socket.attach("tstv1-a", "1", sink());
    f.sockets[2].open();
    f.socket.stop();
    assertEquals(f.clock.jobs.size, 0);
  } finally {
    f.socket.stop();
  }
});

Deno.test("terminal socket is lazy, isolates snapshot/bytes and preserves live renderer state on resize", () => {
  const f = fixture(), a = sink(), b = sink();
  try {
    assertEquals(f.sockets.length, 0);
    f.socket.attach("tstv1-a", "1", a);
    f.socket.attach("tstv1-a", "2", b);
    assertEquals(f.sockets.length, 1);
    assertEquals(f.urls, ["ws://otk.test/mount/api/terminal"]);
    const s = f.sockets[0];
    s.open();
    assertEquals(s.binaryType, "arraybuffer");
    assertEquals(s.controls("attach"), [
      { t: "attach", ch: 1, session: "tstv1-a", terminal: "1" },
      { t: "attach", ch: 2, session: "tstv1-a", terminal: "2" },
    ]);
    s.bytes(1, "premature");
    s.message({
      t: "resized",
      ch: 1,
      cols: 100,
      rows: 30,
      checkpoint: btoa("ignored"),
    });
    s.snapshot(2, "B");
    s.bytes(2, "b");
    s.snapshot(1, "A");
    s.bytes(1, "a");
    assertEquals(a.events, [["reset", 80, 24, [65]], ["write", [97]]]);
    assertEquals(b.events, [["reset", 80, 24, [66]], ["write", [98]]]);
    s.message({
      t: "resized",
      ch: 1,
      cols: 120,
      rows: 40,
      checkpoint: btoa("R"),
    });
    s.bytes(1, "r");
    assertEquals(a.events.slice(-2), [["resize", 120, 40], ["write", [
      114,
    ]]]);
    s.message({
      t: "meta",
      ch: 2,
      foreground: "less",
      role: "controller",
      title: "pager",
    });
    assertEquals(b.metas.at(-1), {
      foreground: "less",
      role: "controller",
      title: "pager",
    });
    s.message({ t: "ping" });
    assertEquals(s.controls("pong"), [{ t: "pong" }]);
  } finally {
    f.socket.stop();
  }
  const secure = fixture("https://otk.test/api/");
  try {
    secure.socket.attach("tstv1-a", "1", sink());
    assertEquals(secure.urls, ["wss://otk.test/api/terminal"]);
  } finally {
    secure.socket.stop();
  }
});

Deno.test("terminal input uses big-endian channel prefix, lossless 64 KiB framing and independent resize", () => {
  const f = fixture();
  try {
    f.socket.attach("tstv1-a", "1", sink());
    const a = f.socket.attach("tstv1-a", "2", sink());
    const s = f.sockets[0];
    s.open();
    a.input(new Uint8Array([99]));
    assertEquals(s.sent.filter((v) => typeof v !== "string").length, 0);
    s.snapshot(2);
    const input = Uint8Array.from({ length: 140000 }, (_, i) => i % 256);
    a.input(input);
    a.resize(90, 32);
    const frames = s.sent.filter((v): v is Uint8Array =>
      v instanceof Uint8Array
    );
    assertEquals([...frames[0].subarray(0, 4)], [0, 0, 0, 2]);
    assertEquals(frames.map((v) => v.length), [65536, 65536, 8940]);
    assert(
      frames.every((v) => new DataView(v.buffer).getUint32(0, false) === 2),
    );
    assertEquals(
      new Uint8Array(frames.flatMap((v) => [...v.subarray(4)])),
      input,
    );
    assertEquals(s.controls("resize"), [{
      t: "resize",
      ch: 2,
      cols: 90,
      rows: 32,
    }]);
    assertThrows(() => a.resize(0, 10), RangeError);
    a.close();
    a.input(input);
    a.resize(20, 20);
    assertEquals(s.controls("resize").length, 1);
  } finally {
    f.socket.stop();
  }
});

Deno.test("session retains four LRU renderers, evicts the least recent and disposes only its own leases", async () => {
  const f = fixture(),
    owner = new SessionTerminals(f.socket, f.conn, "tstv1-a"),
    other = new SessionTerminals(f.socket, f.conn, "tstv1-b");
  const sinks = Array.from({ length: 6 }, sink);
  try {
    await owner.refresh();
    for (let i = 0; i < 4; i++) owner.show(String(i + 1), sinks[i]);
    other.show("6", sinks[5]);
    const s = f.sockets[0];
    s.open();
    await flush();
    owner.show("1", sinks[0]);
    owner.show("5", sinks[4]);
    assertEquals(s.controls("detach").map((v) => v.ch), [2]);
    assertEquals(s.controls("attach").length, 6);
    assertEquals(owner.state.selected, "5");
    assertEquals(owner.state.retained, ["3", "4", "1", "5"]);
    assert(!owner.state.disconnected.includes("2"));
    // Hidden retained renderers continue to consume live output.
    s.snapshot(3);
    s.bytes(3, "hidden");
    assertEquals(sinks[2].events.length, 2);
    owner.dispose();
    assertEquals(s.controls("detach").map((v) => v.ch), [2, 3, 4, 1, 6]);
    s.snapshot(5);
    s.bytes(5, "other");
    assertEquals(sinks[5].events.length, 2);
    assertEquals(f.calls.filter((v) => v.method === "terminal.close"), []);
  } finally {
    owner.dispose();
    other.dispose();
    f.socket.stop();
  }
});

Deno.test("unexpected close backs off 1/2/4/8/10 seconds, reattaches every retained channel and fences old callbacks", async () => {
  const f = fixture(),
    owner = new SessionTerminals(f.socket, f.conn, "tstv1-a"),
    sinks = [sink(), sink()];
  try {
    owner.show("1", sinks[0]);
    owner.show("2", sinks[1]);
    f.sockets[0].open();
    await flush();
    const staleMessage = f.sockets[0].onmessage!,
      staleOpen = f.sockets[0].onopen!;
    let at = 0;
    for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
      f.sockets[at].fail();
      f.clock.tick(delay - 1);
      assertEquals(f.sockets.length, at + 1);
      f.clock.tick(1);
      at++;
      assertEquals(f.sockets.length, at + 1);
      const s = f.sockets[at];
      s.open();
      assertEquals(s.controls("attach").map((v) => v.terminal), ["1", "2"]);
    }
    const s = f.sockets[at];
    s.snapshot(1);
    s.bytes(1, "live");
    staleOpen();
    staleMessage({
      data: JSON.stringify({
        t: "snapshot",
        ch: 1,
        cols: 1,
        rows: 1,
        checkpoint: "",
        title: "stale",
      }),
    });
    staleMessage({ data: frame(1, new Uint8Array([0])).buffer });
    assertEquals(sinks[0].events.length, 2);
    await flush();
    assertEquals(f.calls.filter((v) => v.method === "terminal.list").length, 7);
    s.fail();
    f.clock.tick(1000);
    assertEquals(f.sockets.length, at + 2);
  } finally {
    owner.dispose();
    f.socket.stop();
  }
});

Deno.test("terminated and natural exit refresh lists without reattach; gone refreshes all sessions", async () => {
  const f = fixture(),
    owner = new SessionTerminals(f.socket, f.conn, "tstv1-a"),
    other = new SessionTerminals(f.socket, f.conn, "tstv1-b");
  const a = sink(), b = sink();
  try {
    owner.show("1", a);
    owner.show("2", b);
    other.show("3", sink());
    const s = f.sockets[0];
    s.open();
    await flush();
    f.setList([info("2"), info("3")]);
    s.message({ t: "detached", ch: 1, reason: "terminated" });
    await flush();
    assertEquals(owner.state.list.map((v) => v.id), ["2", "3"]);
    assertEquals(s.controls("attach").length, 3);
    f.setList([{ ...info("2"), status: "exited", exitCode: 3 }, info("3")]);
    s.message({ t: "exited", ch: 2, exitCode: 3 });
    await flush();
    assertEquals(owner.state.selected, "2");
    assert(b.metas.some((m) => m.exited === 3 && m.status === "exited"));
    assertEquals(owner.state.list[0].exitCode, 3);
    assert(!owner.state.retained.includes("2"));
    assertEquals(s.controls("attach").length, 3);
    assertEquals(f.calls.filter((v) => v.method === "terminal.list").length, 4);
    f.setList([]);
    s.message({ t: "gone" });
    await flush();
    assertEquals(owner.state.list, []);
    assertEquals(other.state.list, []);
    s.fail();
    f.clock.tick(60000);
    assertEquals(f.sockets.length, 1);
    assertEquals(f.calls.filter((v) => v.method === "terminal.list").length, 6);
  } finally {
    owner.dispose();
    other.dispose();
    f.socket.stop();
  }
});

Deno.test("lag retries once with a fresh channel; second lag within 10 s stays disconnected until explicit selection", async () => {
  const f = fixture(),
    owner = new SessionTerminals(f.socket, f.conn, "tstv1-a"),
    a = sink();
  try {
    owner.show("1", a);
    const s = f.sockets[0];
    s.open();
    await flush();
    s.snapshot(1);
    s.message({ t: "detached", ch: 1, reason: "lagging" });
    assertEquals(s.controls("attach").map((v) => v.ch), [1, 2]);
    s.snapshot(2, "fresh");
    s.bytes(1, "old");
    s.bytes(2, "new");
    assertEquals(a.events.length, 3);
    f.clock.tick(9999);
    s.message({ t: "detached", ch: 2, reason: "lagging" });
    assertEquals(s.controls("attach").length, 2);
    assertEquals(owner.state.disconnected, ["1"]);
    s.fail();
    f.clock.tick(10000);
    assertEquals(f.sockets.length, 1);
    owner.show("1", a);
    assertEquals(f.sockets.length, 2);
    const next = f.sockets[1];
    next.open();
    next.snapshot(1);
    assertEquals(owner.state.disconnected, []);
    next.message({ t: "detached", ch: 1, reason: "lagging" });
    next.snapshot(2);
    f.clock.tick(10000);
    next.message({ t: "detached", ch: 2, reason: "lagging" });
    assertEquals(next.controls("attach").map((v) => v.ch), [1, 2, 3]);
  } finally {
    owner.dispose();
    f.socket.stop();
  }
});

Deno.test("silent CONNECTING transport expires and releases its handshake deadline", () => {
  const f = fixture();
  try {
    f.socket.attach("tstv1-a", "1", sink());
    f.clock.tick(44_999);
    assertEquals(f.sockets[0].closed, 0);
    f.clock.tick(1);
    assertEquals(f.sockets[0].closed, 1);
    f.clock.tick(1000);
    assertEquals(f.sockets.length, 2);
    f.sockets[1].open();
    f.sockets[1].snapshot(1);
    f.clock.tick(44_999);
    assertEquals(f.sockets[1].closed, 0);
    f.socket.stop();
    assertEquals(f.clock.jobs.size, 0);
  } finally {
    f.socket.stop();
  }
});

Deno.test("reentrant disposal during initial metadata cannot retain the new lease", () => {
  const f = fixture(),
    owner = new SessionTerminals(f.socket, f.conn, "tstv1-a"),
    target = sink();
  let disposed = false;
  owner.subscribe(() => {
    if (disposed) return;
    disposed = true;
    owner.dispose();
  });
  try {
    const attachment = owner.show("1", target);
    assert(!attachment.retained);
    assertEquals(owner.state.retained, []);
    f.sockets[0]?.open();
    f.sockets[0]?.snapshot(1);
    f.sockets[0]?.bytes(1, "after-dispose");
    assertEquals(target.events, []);
  } finally {
    owner.dispose();
    f.socket.stop();
  }
});

Deno.test("LRU replacement releases its shared mux slot before attaching", async () => {
  const f = fixture(),
    owners = Array.from(
      { length: 4 },
      (_, index) => new SessionTerminals(f.socket, f.conn, "tstv1-" + index),
    );
  try {
    for (const owner of owners) {
      for (let id = 1; id <= 4; id++) owner.show(String(id), sink());
    }
    const socket = f.sockets[0];
    socket.open();
    await flush();
    const start = socket.sent.length;
    owners[0].show("5", sink());
    assertEquals(
      socket.sent.slice(start).filter((data): data is string =>
        typeof data === "string"
      ).map((data) => JSON.parse(data).t),
      ["detach", "attach"],
    );
  } finally {
    for (const owner of owners) owner.dispose();
    f.socket.stop();
  }
});

Deno.test("live metadata received during a list read wins over its stale result", async () => {
  const f = fixture(),
    owner = new SessionTerminals(f.socket, f.conn, "tstv1-a");
  try {
    await owner.refresh();
    owner.show("1", sink());
    const socket = f.sockets[0];
    socket.open();
    await flush();
    let reply!: (value: TerminalInfo[]) => void;
    const result = new Promise<TerminalInfo[]>((resolve) => reply = resolve);
    f.setRead(() => result);
    const refresh = owner.refresh();
    socket.message({
      t: "meta",
      ch: 1,
      title: "live-title",
      foreground: "less",
    });
    reply([info("1")]);
    await refresh;
    assertEquals(owner.state.list[0].title, "live-title");
    assertEquals(owner.state.list[0].foreground, "less");
  } finally {
    owner.dispose();
    f.socket.stop();
  }
});

Deno.test("last detach idles the socket for 60 s; reattach cancels idle and channel numbers are never reused", () => {
  const f = fixture();
  try {
    const a = f.socket.attach("tstv1-a", "1", sink());
    const s = f.sockets[0];
    s.open();
    a.close();
    f.clock.tick(59999);
    assertEquals(s.closed, 0);
    const b = f.socket.attach("tstv1-a", "2", sink());
    f.clock.tick(1);
    assertEquals(s.closed, 0);
    assertEquals(s.controls("attach").map((v) => v.ch), [1, 2]);
    b.close();
    f.clock.tick(60000);
    assertEquals(s.closed, 1);
    assertEquals(f.clock.jobs.size, 0);
  } finally {
    f.socket.stop();
  }
});

Deno.test("list reads fence stale results, preserve last-good state on failure, and create/close refresh with captured session", async () => {
  const f = fixture(),
    owner = new SessionTerminals(f.socket, f.conn, "tstv1-a");
  try {
    await owner.refresh();
    assertEquals(owner.state.list.length, 6);
    const first = Promise.withResolvers<TerminalInfo[]>(),
      second = Promise.withResolvers<TerminalInfo[]>();
    f.setRead(() => first.promise);
    const old = owner.refresh();
    f.setRead(() => second.promise);
    const fresh = owner.refresh();
    assertEquals(f.calls.at(-2)?.signal?.aborted, true);
    second.resolve([info("2")]);
    await fresh;
    first.resolve([info("1")]);
    await old;
    assertEquals(owner.state.list.map((v) => v.id), ["2"]);
    f.setRead(() => Promise.reject(new Error("offline")));
    await owner.refresh();
    assert(owner.state.error);
    assertEquals(owner.state.list.map((v) => v.id), ["2"]);
    f.setRead(undefined);
    const created = await owner.create(120, 40);
    assertEquals(created.id, "7");
    assertEquals(owner.state.selected, "7");
    await owner.close("7");
    assert(!owner.state.list.some((v) => v.id === "7"));
    assertEquals(f.calls.filter((v) => v.method !== "terminal.list"), [
      {
        method: "terminal.create",
        params: { sessionID: "tstv1-a", cols: 120, rows: 40 },
        signal: undefined,
      },
      {
        method: "terminal.close",
        params: { sessionID: "tstv1-a", terminalID: "7" },
        signal: undefined,
      },
    ]);
    const retired = Promise.withResolvers<TerminalInfo[]>();
    f.setRead(() => retired.promise);
    const pending = owner.refresh();
    owner.dispose();
    retired.resolve([info("stale")]);
    await pending;
    assertEquals(f.calls.at(-1)?.signal?.aborted, true);
    assert(!owner.state.list.some((v) => v.id === "stale"));
    await assertRejects(() => owner.create(80, 24), Error, "disposed");
  } finally {
    owner.dispose();
    f.socket.stop();
  }
});

Deno.test("not-found retires its attachment and refreshes; selecting an exited tab takes a fresh snapshot", async () => {
  const f = fixture(),
    owner = new SessionTerminals(f.socket, f.conn, "tstv1-a"),
    a = sink();
  try {
    const attachment = owner.show("1", a);
    const s = f.sockets[0];
    s.open();
    await flush();
    s.snapshot(1);
    s.message({ t: "exited", ch: 1, exitCode: 0 });
    await flush();
    assertEquals(attachment.retained, false);
    owner.show("1", a);
    assertEquals(s.controls("attach").map((v) => v.ch), [1, 2]);
    s.snapshot(2, "exited");
    f.setList([]);
    s.message({ t: "error", ch: 2, code: "not-found" });
    await flush();
    assertEquals(owner.state.list, []);
    assertEquals(owner.state.retained, []);
    assertEquals(owner.state.disconnected, []);
    assertEquals(s.controls("attach").length, 2);
  } finally {
    owner.dispose();
    f.socket.stop();
  }
});

Deno.test("session terminal state stays invocation-current with a deferred binding", async () => {
  const f = fixture(), updates: (() => void)[] = [];
  const factory: StateFactory = (initial) => {
    const store = createState(initial);
    return {
      ...store,
      update: (change) => {
        updates.push(() => store.update(change));
      },
    };
  };
  const owner = new SessionTerminals(f.socket, f.conn, "tstv1-a", factory);
  try {
    await owner.refresh();
    owner.show("3", sink());
    assertEquals(owner.state.selected, "3");
    assertEquals(owner.state.list.length, 6);
    for (const update of updates) update();
  } finally {
    owner.dispose();
    f.socket.stop();
  }
});
