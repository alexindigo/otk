// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { SidecarConnection } from "../connection.ts";
import { createSidecars } from "../sidecars.ts";
import { PROTOCOL_VERSION } from "@otk/protocol";

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
    await assertRejects(() => work!, TypeError);
  } finally {
    collection.stop();
  }
});
Deno.test("replacement connections retire sockets RPCs availability and every old callback", async () => {
  const original = globalThis.fetch,
    sockets: Socket[] = [],
    frames: unknown[] = [];
  globalThis.fetch = () =>
    Promise.resolve(Response.json({ authenticated: true }));
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame: (frame) => frames.push(frame),
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
    const pending = connection.rpc.call("usage.get", { sessionID: "s" });
    const rejected = assertRejects(() => pending, Error, "disconnected");
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
    await rejected;
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
