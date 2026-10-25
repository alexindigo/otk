// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { menuReady } from "../support/menu.ts";

const menu = ':popover-open [role="menu"][aria-label="Context menu"]';
async function rightClick(b: Cdp, selector: string) {
  const point = await b.evaluate<{ x: number; y: number }>(
    `(async()=>{const el=document.querySelector(${
      JSON.stringify(selector)
    });el.scrollIntoView({block:'center',behavior:'instant'});await new Promise(requestAnimationFrame);const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await b.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "right",
      buttons: type === "mousePressed" ? 2 : 0,
      clickCount: 1,
    });
  }
}
for (const theme of ["otk-dark", "otk-light"]) {
  test(`native text context survives pointer and keyboard invocation in ${theme}`, async () => {
    const root = await fixture(),
      f = await inboxBrowserFixture(root),
      b = await Cdp.launch(root),
      c = new WsClient(f.url);
    try {
      await c.connect();
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await c.rpc("layout.patch", { rightCollapsed: false });
      await b.goto(f.url);
      await openSession(b, "otk");
      await b.fill('textarea[name="prompt"]', "Speling stays with the browser");
      await b.evaluate(`(()=>{
        document.addEventListener('contextmenu',e=>globalThis.nativeContext={prevented:e.defaultPrevented,trusted:e.isTrusted});
        document.addEventListener('keydown',e=>{if(e.key==='ContextMenu'||e.key==='F10')globalThis.nativeKey={prevented:e.defaultPrevented,trusted:e.isTrusted}},true);
      })()`);
      const native = async (selector: string) => {
        await b.evaluate("globalThis.nativeContext=undefined");
        await rightClick(b, selector);
        await b.poll("globalThis.nativeContext?.trusted===true");
        assertEquals(
          await b.evaluate("globalThis.nativeContext.prevented"),
          false,
          selector,
        );
        await b.poll(`!document.querySelector(${JSON.stringify(menu)})`);
        await b.key("Escape");
        await b.click(selector);
        for (const key of ["ContextMenu", "F10"]) {
          await b.evaluate("globalThis.nativeKey=undefined");
          await b.key(key, key === "F10" ? 8 : 0);
          await b.poll("globalThis.nativeKey?.trusted===true");
          assertEquals(
            await b.evaluate("globalThis.nativeKey.prevented"),
            false,
            selector + " " + key,
          );
          await b.poll(`!document.querySelector(${JSON.stringify(menu)})`);
          await b.key("Escape");
        }
      };
      await native('textarea[name="prompt"]');
      await native('input[placeholder="Find a session"]');
      const shots = Deno.env.get("OTK_NITS_SHOTS");
      if (shots) await b.screenshot(join(shots, `nits-native-${theme}.png`));
      for (
        const type of [
          "text",
          "search",
          "email",
          "password",
          "url",
          "tel",
          "number",
        ]
      ) {
        await b.evaluate(
          `(()=>{const el=document.createElement('input');el.id='native-field';el.type=${
            JSON.stringify(type)
          };el.value='123';document.querySelector('.otk-messages').prepend(el)})()`,
        );
        await native("#native-field");
        await b.evaluate("document.querySelector('#native-field').remove()");
      }
      await b.evaluate(
        `(()=>{const el=document.createElement('div');el.id='native-edit';el.contentEditable='true';el.innerHTML='<span>Editable spelling</span>';document.querySelector('.otk-messages').prepend(el)})()`,
      );
      await native("#native-edit span");
      // A text selection inside a field must not become OTK's selection Copy.
      await b.evaluate(
        "(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector('#native-edit span'));getSelection().removeAllRanges();getSelection().addRange(r)})()",
      );
      await native("#native-edit span");
      await rightClick(b, ".otk-tabs-project");
      await menuReady(b, menu);
      assertEquals(
        await b.evaluate("globalThis.nativeContext.prevented"),
        true,
      );
      if (shots) await b.screenshot(join(shots, `nits-custom-${theme}.png`));
      assertEquals(b.errors, []);
    } finally {
      await c.close();
      await b.close();
      await f.app.stop();
    }
  });
}
