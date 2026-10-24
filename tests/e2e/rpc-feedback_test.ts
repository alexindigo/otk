// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";

test("request owners report RPC failures once while unsolicited errors still reach notifications", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root);
  try {
    await b.goto(f.url + "/#/local/otk");
    await b.poll(
      "!!document.querySelector('[aria-label=\"Collapse projects\"]')",
    );
    await b.evaluate(`(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(value) {
        globalThis.feedbackSocket=this;
        const frame = JSON.parse(value);
        if(frame.t==='rpc' && frame.method==='layout.patch') frame.params={leftWidth:'invalid'};
        if(frame.t==='rpc' && frame.method==='prefs.set') frame.params={key:frame.params.key,value:{invalid:true}};
        return send.call(this,JSON.stringify(frame));
      };
    })()`);
    await b.click('[aria-label="Collapse projects"]');
    await b.poll("!!document.querySelector('.otk-toast-message')");
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-toast-message').length",
      ),
      1,
    );
    await b.click('[aria-label="Display options"]');
    await b.click('.otk-display-menu input[name="timestamps"]');
    await b.poll("!!document.querySelector('.otk-display-menu [role=alert]')");
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-toast-message').length",
      ),
      1,
    );
    await b.evaluate(
      "globalThis.feedbackSocket.dispatchEvent(new MessageEvent('message', {data:JSON.stringify({t:'error',code:'fixture',message:'Unsolicited protocol failure'})}))",
    );
    await b.poll(
      "Array.from(document.querySelectorAll('.otk-toast-message')).some(item=>item.textContent.includes('Unsolicited protocol failure'))",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-toast-message').length",
      ),
      2,
    );
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await f.app.stop();
  }
});
