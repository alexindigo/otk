// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createRoot, flush } from "solid-js";
import { PROTOCOL_VERSION } from "@otk/protocol";
import { createSidecars } from "../../../web/src/state/sidecars.ts";

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
    constructor() {
      Socket.current = this;
    }
    send() {}
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
    for (const capabilities of [undefined, [], ["prompt"]]) {
      let sidecars!: ReturnType<typeof createSidecars>, dispose!: () => void;
      createRoot((stop) => {
        dispose = stop;
        sidecars = createSidecars(() => {});
      });
      try {
        const connection = sidecars.connection("local");
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
        flush();
        const expected = capabilities ?? legacy;
        assertEquals(sidecars.state.list[0].capabilities, expected);
        assertEquals(
          connection.supports("permissions"),
          expected.includes("permissions"),
        );
        assertEquals(
          connection.supports("prompt"),
          expected.includes("prompt"),
        );
      } finally {
        sidecars.stop();
        dispose();
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
