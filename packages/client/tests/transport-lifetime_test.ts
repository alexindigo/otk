// SPDX-License-Identifier: LGPL-3.0-only
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { SidecarConnection } from "../connection.ts";
import { createSidecars } from "../sidecars.ts";
import { FeedbackFailure } from "../failures.ts";
import { PROTOCOL_VERSION } from "@otk/protocol";
import {
  bootstrapFetch,
  fixtureRequestPolicy,
  fixtureRequests,
  replyRequest,
} from "../../../tests/support/request-wire.ts";
import { bounded } from "../../../tests/support/resources.ts";

class Socket {
  readyState: number = WebSocket.CONNECTING;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: string[] = [];
  closed = 0;
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.closed++;
    this.readyState = WebSocket.CLOSED;
  }
  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
  welcome(requests = fixtureRequests()) {
    this.onmessage?.({
      data: JSON.stringify({
        t: "welcome",
        protocol: PROTOCOL_VERSION,
        messages: fixtureMessagePolicy,
        requests,
        sidecar: {
          version: "test",
          harness: {
            kind: "test",
            version: "1",
            url: "",
            capabilities: ["usage"],
          },
        },
      }),
    });
  }
}
Deno.test("view changes preserve the ordered inbox patch stream but fence old snapshots", async () => {
  const socket = new Socket();
  const frames: string[] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame(frame) {
      frames.push(frame.t);
    },
  }, {
    fetcher: bootstrapFetch(),
    socket: () => socket as unknown as WebSocket,
  });
  try {
    await connection.connect();
    socket.open();
    socket.welcome();
    const previous = connection.viewEpoch;
    connection.view({ directory: "/project", crumbs: [], rows: [] });
    for (const t of ["index.snapshot", "inbox.snapshot", "inbox.patch"]) {
      socket.onmessage!({
        data: JSON.stringify({ t, epoch: previous }),
      });
    }
    assertEquals(frames, ["welcome", "inbox.patch"]);
  } finally {
    connection.stop();
  }
});
Deno.test("incompatible hello and welcome publish OTK was updated with an owner-supplied Reload", async () => {
  for (
    const frame of [
      {
        t: "error",
        code: "protocol",
        reason: "client-outdated",
        protocol: 999,
        build: "new-build",
      },
      { t: "error", code: "protocol" },
      { t: "welcome", protocol: 999 },
    ]
  ) {
    const socket = new Socket();
    let latest: {
      state: string;
      error?: string;
      feedback?: import("../failures.ts").Feedback;
    } | undefined;
    let reloads = 0;
    const connection = new SidecarConnection("http://example.test", {
      status(state, error, _auth, feedback) {
        latest = { state, error, feedback };
      },
      frame() {},
    }, {
      fetcher: bootstrapFetch(),
      socket: () => socket as unknown as WebSocket,
      reload: () => {
        reloads++;
      },
    });
    try {
      await connection.connect();
      const pending = connection.requests.start("session.prompt", {
        sessionID: "tstv1-pending",
        mode: "normal",
        parts: [{ kind: "text", text: "kept" }],
      });
      socket.open();
      socket.onmessage!({ data: JSON.stringify(frame) });
      assertEquals(pending.state.connection, "client-outdated");
      assertEquals(latest?.state, "client outdated");
      assertEquals(latest?.error, undefined);
      assertEquals(latest?.feedback?.text, "OTK was updated");
      assertEquals(latest?.feedback?.action?.label, "Reload");
      latest?.feedback?.action?.run();
      assertEquals(reloads, 1);
      assertEquals(socket.closed, 1);
    } finally {
      connection.stop();
    }
  }
});
Deno.test("restart 503s at admission and request-events reconnect automatically and renew the request window", async () => {
  const policy = { ...fixtureRequestPolicy, retrybase: 1, retrymax: 2 };
  const sockets: Socket[] = [];
  const statuses: { state: string; error?: string }[] = [];
  const recovered = Promise.withResolvers<void>();
  const bootstrap = bootstrapFetch();
  let restarting = false, admissions = 0, unavailableAt = 0, retriedAt = 0;
  const connection = new SidecarConnection("http://example.test", {
    status(state, error) {
      statuses.push({ state, error });
      if (state === "connected" && restarting) recovered.resolve();
    },
    frame() {},
  }, {
    policy,
    fetcher(input, init) {
      const events = String(input).endsWith("request-events");
      if (restarting) {
        if (!events && ++admissions === 1) {
          unavailableAt = performance.now();
          return Promise.resolve(
            new Response("Starting", {
              status: 503,
              headers: { "Retry-After": "1" },
            }),
          );
        }
        if (!events && admissions === 2) retriedAt = performance.now();
        if (events && admissions === 2) {
          return Promise.resolve(
            new Response("proxy unavailable", { status: 503 }),
          );
        }
      }
      return bootstrap(input, init);
    },
    socket() {
      const socket = new Socket();
      sockets.push(socket);
      if (restarting) {
        queueMicrotask(() => {
          socket.open();
          socket.welcome({ ...fixtureRequests(), policy });
        });
      }
      return socket as unknown as WebSocket;
    },
  });
  try {
    await connection.connect();
    sockets[0].open();
    sockets[0].welcome({ ...fixtureRequests(), policy });
    const pending = connection.rpc.start("usage.get", {
      sessionID: "s",
      turnID: "user",
    });
    const oldWindow = pending.state.ref.window;
    restarting = true;
    sockets[0].onclose!();
    await bounded(
      "503 restart must reconnect without reload",
      recovered.promise,
      3000,
    );
    assertEquals(admissions, 3);
    assert(
      retriedAt - unavailableAt >= 990,
      "Retry-After must be honored beyond retrymax",
    );
    assertEquals(statuses.some(({ error }) => error !== undefined), false);
    assert(statuses.some(({ state }) => state === "reconnecting"));
    assertEquals(statuses.at(-1)?.state, "connected");
    assert(
      pending.state.ref.window !== oldWindow,
      "WP14 renews the pending read",
    );
    const fresh = connection.rpc.start("usage.get", {
      sessionID: "fresh",
      turnID: "user",
    });
    assertEquals(fresh.state.ref.window, pending.state.ref.window);
    fresh.release();
    replyRequest(connection.rpc, {
      t: "request",
      ref: pending.state.ref,
      method: "usage.get",
      params: {},
    }, { sessionID: "s", turnID: "user" });
    assertEquals((await pending.result).sessionID, "s");
  } finally {
    connection.stop();
  }
});
Deno.test("@load @transport first-page acceptance waits for the consumer and fences selection ABA and reconnect", async () => {
  const sockets: Socket[] = [], renders: (() => void)[] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, {
    fetcher: bootstrapFetch(),
    afterRender: (accepted) => renders.push(accepted),
    socket() {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const select = (id: string) =>
    connection.view({ selected: id, crumbs: [], rows: [] });
  const settlements = () =>
    sockets.flatMap((s) => s.sent.map((f) => JSON.parse(f))).filter((f) =>
      f.t === "view.settled"
    );
  try {
    select("tstv1-a");
    await connection.connect();
    sockets[0].open();
    sockets[0].welcome();
    const stale = connection.firstPage("tstv1-a");
    stale();
    assertEquals(settlements(), []);
    select("tstv1-b");
    select("tstv1-a");
    renders.shift()!();
    assertEquals(settlements(), []);
    const accepted = connection.firstPage("tstv1-a");
    accepted();
    // Same selection's row changes retain the barrier and use the current epoch.
    connection.view({ selected: "tstv1-a", crumbs: [], rows: ["tstv1-row"] });
    renders.shift()!();
    assertEquals(settlements(), [{
      t: "view.settled",
      epoch: connection.viewEpoch,
      sessionID: "tstv1-a",
    }]);
    accepted();
    renders.shift()!();
    assertEquals(settlements().length, 1);
    await connection.connect();
    sockets[1].open();
    sockets[1].welcome();
    accepted();
    renders.shift()!();
    assertEquals(settlements().length, 1);
    connection.firstPage("tstv1-a")();
    renders.shift()!();
    assertEquals(settlements().length, 2);
  } finally {
    connection.stop();
  }
});
Deno.test("view epochs survive reconnect and retire late scoped publications before reduction", async () => {
  const sockets: Socket[] = [], frames: unknown[] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame: (frame) => {
      frames.push(frame);
    },
  }, {
    fetcher: bootstrapFetch(),
    socket() {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  try {
    connection.view({
      directory: "/x",
      selected: "tstv1-x",
      crumbs: [],
      rows: [],
    });
    await connection.connect();
    sockets[0].open();
    sockets[0].welcome();
    assertEquals(JSON.parse(sockets[0].sent[0]).view.selected, "tstv1-x");
    connection.view({
      directory: "/y",
      selected: "tstv1-y",
      crumbs: [],
      rows: [],
    });
    const at = frames.length;
    sockets[0].onmessage!({
      data: JSON.stringify({
        t: "index.snapshot",
        epoch: 1,
        rev: 0,
        entries: [],
      }),
    });
    assertEquals(frames.length, at);
    assertEquals(
      sockets[0].sent.some((value) => JSON.parse(value).t === "index.applied"),
      false,
    );
    sockets[0].onmessage!({
      data: JSON.stringify({
        t: "index.snapshot",
        epoch: 2,
        rev: 0,
        entries: [],
      }),
    });
    assertEquals(frames.length, at + 1);
    assertEquals(JSON.parse(sockets[0].sent.at(-1)!), {
      t: "index.applied",
      epoch: 2,
      rev: 0,
    });
    await connection.connect();
    sockets[1].open();
    assertEquals(JSON.parse(sockets[1].sent[0]).view.epoch, 2);
    assertEquals(JSON.parse(sockets[1].sent[0]).view.selected, "tstv1-y");
  } finally {
    connection.stop();
  }
});
Deno.test("invalid sidecar additions reject through their asynchronous API boundary", async () => {
  const collection = createSidecars(() => {}, {
    storage: { getItem: () => "[]", setItem() {} },
  });
  let work: Promise<string> | undefined;
  try {
    let synchronous: unknown;
    try {
      work = collection.add("not a URL", "Invalid");
    } catch (error) {
      synchronous = error;
    }
    assertEquals(
      synchronous,
      undefined,
      "Invalid add escaped its Promise boundary",
    );
    await assertRejects(() => work!, FeedbackFailure, "HTTP(S) base URL");
  } finally {
    collection.stop();
  }
});
Deno.test("replacement connections retire sockets RPCs availability and every old callback", async () => {
  const original = globalThis.fetch,
    sockets: Socket[] = [],
    frames: unknown[] = [];
  globalThis.fetch = bootstrapFetch();
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame: (frame) => {
      frames.push(frame);
    },
  }, {
    socket() {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  try {
    await connection.connect();
    sockets[0].open();
    sockets[0].welcome();
    const pending = connection.rpc.start("usage.get", {
      sessionID: "s",
      turnID: "user",
    });
    let settled = false;
    void pending.result.then(() => settled = true, () => settled = true);
    const staleOpen = sockets[0].onopen!, staleMessage = sockets[0].onmessage!;
    const replacing = connection.connect();
    assertEquals(
      connection.supports("usage"),
      false,
      "Replacement retained old availability",
    );
    await replacing;
    assertEquals(sockets[0].closed, 1, "Superseded socket is still live");
    const before = sockets[0].sent.length;
    staleOpen();
    staleMessage({ data: JSON.stringify({ t: "ping" }) });
    assertEquals(sockets[0].sent.length, before);
    sockets[1].open();
    sockets[1].welcome();
    await Promise.resolve();
    assertEquals(settled, false);
    replyRequest(connection.rpc, {
      t: "request",
      ref: pending.state.ref,
      method: "usage.get",
      params: {},
    }, { sessionID: "s", turnID: "user" });
    assertEquals((await pending.result).sessionID, "s");
    assertEquals(frames.length, 2);
  } finally {
    connection.stop();
    globalThis.fetch = original;
  }
});

Deno.test("sidecar additions share normalized URL ownership and stop rejects late admission", async () => {
  const original = globalThis.fetch,
    entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<Response>();
  let reads = 0, signal: AbortSignal | null | undefined;
  globalThis.fetch = (_url, options) => {
    reads++;
    signal = options?.signal;
    entered.resolve();
    return held.promise;
  };
  const collection = createSidecars(() => {}, {
    storage: { getItem: () => "[]", setItem() {} },
  });
  try {
    const first = collection.add("http://remote.test/", "Remote");
    const second = collection.add("http://remote.test", "Remote");
    const results = Promise.allSettled([first, second]);
    await entered.promise;
    collection.stop();
    held.resolve(Response.json({ ok: true, authenticated: true }));
    const settled = await results;
    assertEquals(reads, 1, "Duplicate discoveries escaped the URL owner");
    assert(signal?.aborted, "Stop did not cancel discovery");
    assert(settled.every((result) => result.status === "rejected"));
    assertEquals(
      collection.state.list.length,
      1,
      "Late add installed a stopped source",
    );
  } finally {
    held.resolve(Response.json({ ok: true }));
    collection.stop();
    globalThis.fetch = original;
  }
});
