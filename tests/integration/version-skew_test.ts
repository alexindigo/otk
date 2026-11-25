// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { PROTOCOL_VERSION, SIDECAR_VERSION } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { bounded, test } from "../support/resources.ts";
// @deno-types="npm:@types/ws@8.18.1"
import WebSocket from "ws";

test("incompatible hello retains the legacy protocol discriminator and supplies server identity", async () => {
  const app = await coreBackendFixture(await fixture());
  const ws = new WebSocket(app.url.replace("http:", "ws:") + "/api/ws", {
    headers: { Origin: app.url },
  });
  const reply = Promise.withResolvers<Record<string, unknown>>();
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", protocol: 20 }));
  ws.on("message", (data) => reply.resolve(JSON.parse(data.toString())));
  ws.on(
    "close",
    (code, reason) => closed.resolve({ code, reason: reason.toString() }),
  );
  try {
    const frame = await bounded("protocol reply", reply.promise, 5000);
    console.log("Protocol-20 reply:", JSON.stringify(frame));
    assertEquals(frame, {
      t: "error",
      code: "protocol",
      reason: "client-outdated",
      protocol: PROTOCOL_VERSION,
      build: SIDECAR_VERSION,
    });
  } finally {
    if (ws.readyState < WebSocket.CLOSING) ws.close();
    const close = await bounded("protocol close", closed.promise, 5000);
    console.log("Protocol close:", close.code, close.reason);
    await app.app.stop();
  }
});
