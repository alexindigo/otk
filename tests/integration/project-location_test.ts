// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import type { Preferences } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";

test("project location intents preserve independent visits and unrelated layout fields", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    a = new WsClient(f.url),
    b = new WsClient(f.url);
  try {
    await a.connect();
    await b.connect();
    const first = { sidecarId: "local", directory: "/a", sessionID: "one" };
    const second = { sidecarId: "remote", directory: "/a", sessionID: "two" };
    await Promise.all([
      a.rpc("layout.location", first),
      b.rpc("layout.location", second),
      a.rpc("layout.patch", { leftWidth: 300 }),
    ]);
    let saved = (await b.rpc<Preferences>("prefs.get", {})).shellLayout;
    assertEquals(
      saved.projectLocations?.sort((a, b) =>
        a.sidecarId.localeCompare(b.sidecarId)
      ),
      [first, second],
    );
    assertEquals(saved.leftWidth, 300);
    await assertRejects(() =>
      a.rpc("layout.location", { ...first, sessionID: 3 })
    );
    await a.rpc("layout.location", { sidecarId: "local", directory: "/a" });
    saved = (await b.rpc<Preferences>("prefs.get", {})).shellLayout;
    assertEquals(saved.projectLocations, [second]);
    assertEquals(saved.leftWidth, 300);
  } finally {
    await a.close();
    await b.close();
    await f.app.stop();
  }
});
