// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DEFAULT_PREFS, type Preferences } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("rapid layout gestures preserve independent fields through broadcast and reload", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    browser = await Cdp.launch(root),
    client = new WsClient(f.url);
  try {
    await client.connect();
    await browser.goto(f.url);
    await browser.poll(
      "!!document.querySelector('.otk-inbox-resizer') && !document.querySelector('[aria-label=\"Collapse projects\"]').disabled",
    );
    // One event turn deliberately holds props/broadcast delivery behind all three
    // gestures. No sleep can make a stale whole-layout write safe.
    await browser.evaluate(`(() => {
      document.querySelector('.otk-inbox-resizer').dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}));
      document.querySelector('[aria-label="Collapse projects"]').click();
      document.querySelector('[aria-label="Open right panel"]').click();
    })()`);
    await browser.poll(
      "!document.querySelector('.otk-right-panel-slot').hidden",
    );
    const expected = {
      ...DEFAULT_PREFS.shellLayout,
      leftWidth: 360,
      leftCollapsed: true,
      rightCollapsed: false,
    };
    assertEquals(
      (await client.rpc<Preferences>("prefs.get", {})).shellLayout,
      expected,
    );
    for (let reload = 0; reload < 2; reload++) {
      if (reload) await browser.reload();
      await browser.poll(
        "document.querySelector('.otk-project-inbox')?.dataset.collapsed==='true' && !document.querySelector('.otk-right-panel-slot').hidden",
      );
      assertEquals(
        await browser.evaluate(
          "document.querySelector('.otk-project-inbox').getBoundingClientRect().width",
        ),
        48,
      );
    }
    await browser.click('[aria-label="Expand projects"]');
    await browser.poll(
      "document.querySelector('.otk-project-inbox').getBoundingClientRect().width===360",
    );
    assertEquals(browser.errors, []);
  } finally {
    await client.close();
    await browser.close();
    await f.app.stop();
  }
});
