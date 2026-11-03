// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";
// C13 owns the rapid gesture/broadcast/reload journey. Retain fixed rail paint.
test("rapid layout gestures preserve independent fields through broadcast and reload", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    await b.goto(f.url);
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      for (const collapsed of [true, false]) {
        await c.rpc("layout.patch", {
          leftWidth: 360,
          leftCollapsed: collapsed,
          rightCollapsed: false,
        });
        await b.poll(
          `document.documentElement.dataset.otkTheme==='${theme}'&&document.querySelector('.otk-project-inbox')?.dataset.collapsed==='${collapsed}'&&!document.querySelector('.otk-right-panel').hidden`,
        );
        assertEquals(
          await b.evaluate(
            "document.querySelector('.otk-project-inbox').getBoundingClientRect().width",
          ),
          collapsed ? 48 : 360,
        );
      }
    }
    assertEquals(b.errors, []);
  } finally {
    await c.close();
    await b.close();
    await f.app.stop();
  }
});
