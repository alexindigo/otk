// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertMatch } from "@std/assert";
import { PROTOCOL_VERSION } from "@otk/protocol";
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
    const health = await (await fetch(`${app.url}/api/health`)).json();
    assertEquals(frame, {
      t: "error",
      code: "protocol",
      reason: "client-outdated",
      protocol: PROTOCOL_VERSION,
      build: health.build,
    });
  } finally {
    if (ws.readyState < WebSocket.CLOSING) ws.close();
    const close = await bounded("protocol close", closed.promise, 5000);
    console.log("Protocol close:", close.code, close.reason);
    await app.app.stop();
  }
});

test("one serving process publishes the same build in HTML, health, discovery and welcomes", async () => {
  const app = await coreBackendFixture(await fixture());
  const welcome = async () => {
    const ws = new WebSocket(app.url.replace("http:", "ws:") + "/api/ws", {
      headers: { Origin: app.url },
    });
    const reply = Promise.withResolvers<Record<string, string>>();
    const closed = Promise.withResolvers<void>();
    ws.onopen = () =>
      ws.send(JSON.stringify({
        t: "hello",
        protocol: PROTOCOL_VERSION,
      }));
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.t === "welcome") reply.resolve(frame.sidecar);
    });
    ws.on("close", () => closed.resolve());
    try {
      return await bounded("welcome", reply.promise, 5000);
    } finally {
      ws.close();
      await bounded("socket close", closed.promise, 5000);
    }
  };
  try {
    const [first, second] = await Promise.all([welcome(), welcome()]);
    const health = await (await fetch(`${app.url}/api/health`)).json();
    const discovery = await (await fetch(`${app.url}/api/discovery`)).json();
    // The focused integration runner also supports an unbundled fixture.
    assertMatch(health.build, /^(?:[a-f0-9]{16}|unbundled)$/);
    assertEquals(first.build, health.build);
    assertEquals(second.build, health.build);
    assertEquals(discovery.build, health.build);
    assertMatch(first.instance, /^[a-f0-9-]{36}$/);
    assertEquals(second.instance, first.instance);
    const html = await (await fetch(`${app.url}/`)).text();
    const boot = html.match(/id="otk-bootstrap">([^<]+)<\/script>/);
    assert(boot);
    assertEquals(JSON.parse(boot[1]).build, health.build);
  } finally {
    await app.app.stop();
  }
});
