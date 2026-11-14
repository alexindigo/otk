// SPDX-License-Identifier: LGPL-3.0-only
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { SidecarConnection } from "../connection.ts";
import { createSidecars } from "../sidecars.ts";
import { FeedbackFailure } from "../failures.ts";
import { PROTOCOL_VERSION } from "@otk/protocol";
import {
  bootstrapFetch,
  fixtureRequests,
  replyRequest,
} from "../../../tests/support/request-wire.ts";

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
  welcome() {
    this.onmessage?.({
      data: JSON.stringify({
        t: "welcome",
        protocol: PROTOCOL_VERSION,
        messages: fixtureMessagePolicy,
        requests: fixtureRequests(),
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
