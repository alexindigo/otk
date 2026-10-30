// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Cdp } from "../support/cdp.ts";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

test("one-line prompt bubbles retain their pre-windowing height in Dark and Linen", async () => {
  const root = await fixture(), f = await inboxBrowserFixture(root);
  const browser = await Cdp.launch(root), probe = new WsClient(f.url);
  try {
    await probe.connect();
    await browser.goto(f.url + "/#/local/tstv1-otk");
    await browser.poll(
      "!!document.querySelector('.otk-user-bubble .otk-prose-paragraph')",
    );
    await browser.evaluate("document.fonts.ready");
    for (const theme of ["otk-dark", "otk-light"]) {
      await probe.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      const geometry = await browser.evaluate<{
        height: number;
        textHeight: number;
        top: number;
        bottom: number;
      }>(`(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const bubble=document.querySelector('.otk-user-bubble').getBoundingClientRect(),text=document.querySelector('.otk-user-bubble .otk-prose-paragraph').getBoundingClientRect();
        return {height:bubble.height,textHeight:text.height,top:text.top-bubble.top,bottom:bubble.bottom-text.bottom};
      })()`);
      console.info("Prompt bubble geometry", theme, geometry);
      // Measured at aff644b in the same Chromium/viewport: 48px in both themes.
      assert(Math.abs(geometry.height - 48) <= 1, JSON.stringify(geometry));
      assertEquals(geometry.textHeight, 24);
      assert(Math.abs(geometry.top - geometry.bottom) <= 1);
      await browser.screenshot(join(root, `prompt-bubble-${theme}.png`));
    }
    assertEquals(browser.errors, []);
  } finally {
    await browser.close();
    await probe.close();
    await f.app.stop();
  }
});
