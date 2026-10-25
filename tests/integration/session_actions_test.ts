// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { test } from "../support/resources.ts";
import { browserFixture } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import type { ContentSession } from "@otk/protocol";

test("session rename validates titles and persists through the real native API", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Original" },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    const renamed = await client.rpc<ContentSession>("session.rename", {
      sessionID: session.id,
      title: "  A precise title  ",
    });
    assertEquals(renamed.title, "A precise title");
    assertEquals(renamed.directory, f.oc.directory);
    assertEquals(
      (await f.oc.request<{ title: string }>(`/session/${session.id}`)).title,
      "A precise title",
    );
    for (const title of ["", "   ", "x".repeat(201), null, 42]) {
      await assertRejects(() =>
        client!.rpc("session.rename", {
          sessionID: session.id,
          title,
        }), Error);
    }
    await assertRejects(() =>
      client!.rpc("session.rename", {
        sessionID: "",
        title: "Valid",
      }), Error);
    assertEquals(
      (await client.rpc<ContentSession>("session.get", {
        sessionID: session.id,
      }))
        .title,
      "A precise title",
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});
