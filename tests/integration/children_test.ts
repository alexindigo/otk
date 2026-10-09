// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { ContentSession } from "../../protocol/content.ts";
import { browserFixture } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
Deno.test("children RPC returns sorted normalized sessions without harness fields", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const root = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Children API" },
    });
    for (const title of ["One", "Two"]) {
      await f.oc.request("/session", {
        method: "POST",
        body: { parentID: root.id, title },
      });
    }
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    const children = await client.rpc<ContentSession[]>("session.children", {
      sessionID: root.id,
    });
    assertEquals(children.length, 2);
    assertEquals(children.map((c) => c.id), children.map((c) => c.id).sort());
    assert(children.every((child) => child.parentID === root.id));
    assert(
      !JSON.stringify(children).includes('"summary"') &&
        !JSON.stringify(children).includes('"permission"'),
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});
