// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { PROTOCOL_VERSION } from "@otk/protocol";
import { createSidecars } from "@otk/client";

declare module "@otk/protocol" {
  interface CapabilityContracts {
    "feature.preview": { preview(): void };
  }
}

Deno.test("welcome consumers retain legacy capabilities while honoring explicit empty/subset advertisements", async () => {
  const keys = ["fetch", "location", "localStorage", "WebSocket"];
  const originals = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  class Socket {
    static OPEN = 1;
    static current: Socket;
    readyState = 1;
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => void;
    sent: string[] = [];
    constructor() {
      Socket.current = this;
    }
    send(value: string) {
      this.sent.push(value);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const install = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  install("location", new URL("http://example.test/"));
  install("localStorage", { getItem: () => null, setItem() {} });
  install(
    "fetch",
    () =>
      Promise.resolve(
        Response.json({
          authenticated: true,
          setupRequired: false,
          authType: "none",
        }),
      ),
  );
  install("WebSocket", Socket);
  const legacy = [
    "prompt",
    "shell",
    "commands",
    "history",
    "files",
    "agents",
    "resources",
    "permissions",
    "questions",
    "revert",
  ];
  try {
    for (
      const capabilities of [
        undefined,
        [],
        ["prompt"],
        [
          "prompt",
          "newer.server.capability",
        ],
        ["models"],
        ["feature.preview"],
      ]
    ) {
      const sidecars = createSidecars(() => {}, {
        connection: { api: new URL("http://example.test/api/") },
      });
      try {
        const connection = sidecars.connection("local");
        connection.subscribe("open", true);
        await connection.connect();
        Socket.current.onopen?.();
        Socket.current.onmessage?.({
          data: JSON.stringify({
            t: "welcome",
            protocol: PROTOCOL_VERSION,
            sidecar: {
              version: "legacy",
              harness: {
                kind: "legacy",
                version: "1",
                url: "http://backend.test",
                ...(capabilities === undefined ? {} : { capabilities }),
              },
            },
          }),
        });
        const expected = capabilities ?? legacy;
        assertEquals(sidecars.state.list[0].capabilities, expected);
        assertEquals(sidecars.state.list[0].connectionVersion, 1);
        assertEquals(
          connection.supports("permissions"),
          expected.includes("permissions"),
        );
        assertEquals(
          connection.supports("prompt"),
          expected.includes("prompt"),
        );
        assertEquals(
          connection.supports("feature.preview"),
          expected.includes("feature.preview"),
          "Extensions require an explicit advertisement, never a legacy default",
        );
        assertEquals(
          connection.supports("models"),
          expected.includes("models"),
          "Models require an explicit advertisement, never a legacy default",
        );
        assertEquals(Socket.current.sent.map((value) => JSON.parse(value).t), [
          "hello",
          "subscribe",
        ]);
        Socket.current.onmessage?.({ data: JSON.stringify({ t: "ping" }) });
        assertEquals(JSON.parse(Socket.current.sent.at(-1)!), { t: "pong" });
        const pending = connection.rpc.call("session.get", {
          sessionID: "open",
        }).catch((error) => error.message);
        Socket.current.close();
        assertEquals(await pending, "Sidecar disconnected");
        assertEquals(sidecars.state.list[0].status, "reconnecting");
        assertEquals(sidecars.state.list[0].connectionVersion, 1);
        assertEquals(sidecars.state.list[0].capabilities, expected);
        assertEquals(connection.supports("prompt"), false);
        await connection.connect();
        Socket.current.onopen?.();
        Socket.current.onmessage?.({
          data: JSON.stringify({
            t: "welcome",
            protocol: PROTOCOL_VERSION,
            sidecar: {
              version: "reconnected",
              harness: {
                kind: "backend",
                version: "1",
                url: "http://backend.test",
                capabilities: expected,
              },
            },
          }),
        });
        assertEquals(Socket.current.sent.map((value) => JSON.parse(value).t), [
          "hello",
          "subscribe",
        ]);
        assertEquals(sidecars.state.list[0].status, "connected");
        assertEquals(sidecars.state.list[0].connectionVersion, 2);
      } finally {
        sidecars.stop();
      }
    }
  } finally {
    for (const key of keys) {
      const descriptor = originals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
