// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import type { ContentSession, SessionListPage } from "@otk/protocol";
import { nativeBehavior as nativeFixture } from "../support/native-testing.ts";
import { WsClient } from "../support/ws-client.ts";
test("children RPC returns sorted normalized sessions without harness fields", async () => {
  const f = await nativeFixture();
  let client: WsClient | undefined;
  try {
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    const root = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Children API",
    });
    for (const title of ["One", "Two"]) {
      await client.rpc("session.create", {
        directory: f.oc.directory,
        parentID: root.id,
        title,
      });
    }
    const page = await client.rpc<SessionListPage>("session.children", {
      sessionID: root.id,
    });
    const children = page.items;
    assertEquals(children.length, 2);
    assertEquals(page.load.state, "complete");
    assertEquals(page.older, null);
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
