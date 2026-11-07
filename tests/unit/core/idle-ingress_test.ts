// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { bind } from "../../../core/http/server.ts";
import { cfg, fixture } from "../../support/config.ts";
import { coreBackendFixture } from "../../support/core-backend.ts";
import { waitFor } from "../../support/opencode.ts";
import { test } from "../../support/resources.ts";
import { WsClient } from "../../support/ws-client.ts";

test("every HTTP ingress resets idle even before routes activate", async () => {
  const settings = cfg();
  settings.server.port = 0;
  let requests = 0;
  const listener = bind(settings, undefined, undefined, () => requests++);
  try {
    for (const path of ["/api/session", "/api/login", "/", "/assets/app.js"]) {
      const response = await fetch(
        `http://127.0.0.1:${listener.server.addr.port}${path}`,
        { method: path.endsWith("login") ? "POST" : "GET" },
      );
      await response.text();
    }
    assertEquals(requests, 4);
  } finally {
    await listener.server.shutdown();
  }
});

test("validated WS acquisition controls reset idle; acknowledgements and malformed controls do not", async () => {
  const fixtureApp = await coreBackendFixture(await fixture());
  let requests = 0;
  fixtureApp.app.connections.requests.requested = () => requests++;
  const client = new WsClient(fixtureApp.url);
  try {
    await client.connect();
    assertEquals(requests, 1, "hello");
    await client.rpc("prefs.get", {});
    assertEquals(requests, 2, "local read");
    await client.rpc("layout.patch", {});
    assertEquals(requests, 3, "local write");
    client.lease({ crumbs: [], rows: [] });
    client.send({ t: "subscribe", sessionID: fixtureApp.session.id });
    client.send({ t: "unsubscribe", sessionID: fixtureApp.session.id });
    client.send({ t: "resnapshot" });
    client.send({ t: "request.resume", items: [] });
    client.send({ t: "request.release", refs: [] });
    await waitFor(() => requests, (n) => n === 9);
    client.send({ t: "pong" });
    client.send({ t: "request.received", refs: [] });
    client.send({ t: "index.applied", epoch: 1, rev: 0 });
    client.send({
      t: "view.settled",
      epoch: 1,
      sessionID: fixtureApp.session.id,
    });
    client.send({ t: "request.resume", items: "invalid" });
    await client.wait((f) => f.t === "error" && f.code === "frame");
    assertEquals(requests, 9);
  } finally {
    await client.close();
    await fixtureApp.app.stop();
  }
});
