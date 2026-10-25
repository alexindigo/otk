// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { Cdp } from "../support/cdp.ts";
import { menuReady } from "../support/menu.ts";
import { WsClient } from "../support/ws-client.ts";

const menu = ':popover-open [role="menu"][aria-label="Context menu"]';
export async function sessionContext(b: Cdp, selector: string) {
  const point = await b.evaluate<{ x: number; y: number }>(`(async()=>{
    const el=document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({block:'center',behavior:'instant'});
    await new Promise(requestAnimationFrame);
    const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await b.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "right",
      buttons: type === "mousePressed" ? 2 : 0,
      clickCount: 1,
    });
  }
  await menuReady(b, menu);
}
async function capture(b: Cdp, name: string) {
  const destination = Deno.env.get("OTK_SESSION_ACTION_SCREENSHOTS");
  if (destination) await b.screenshot(join(destination, `${name}.png`));
}

for (const theme of ["otk-dark", "otk-light"]) {
  test(`rename edits only its tab, chip or row and persists after reload in ${theme}`, async () => {
    const f = await browserFixture();
    let client: WsClient | undefined;
    try {
      const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Session actions" },
      });
      const server = await f.sidecar();
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      const b = await f.browser(server.url);
      await openSession(b, session.id);
      await b.evaluate("document.fonts.ready.then(()=>true)");
      for (
        const [origin, selector] of [
          ["tab", `[data-tab="${session.id}"]`],
          ["chip", `[data-crumb="${session.id}"]`],
          ["row", `[data-session="${session.id}"]`],
        ]
      ) {
        await sessionContext(b, selector);
        if (origin === "tab") await capture(b, `${theme}-session-menu`);
        await b.click(`${menu} [data-context-command="session.rename"]`);
        await b.poll(
          `document.activeElement?.matches('.otk-title-editor input')`,
        );
        assertEquals(
          await b.evaluate(
            "document.querySelectorAll('.otk-title-editor').length",
          ),
          1,
        );
        assertEquals(
          await b.evaluate(
            `document.querySelector('.otk-title-editor')?.dataset.origin`,
          ),
          origin,
        );
        assertEquals(
          await b.evaluate(
            "(()=>{const e=document.activeElement;return e.selectionStart===0&&e.selectionEnd===e.value.length})()",
          ),
          true,
        );
        await capture(b, `${theme}-rename-${origin}`);
        await b.send("Input.insertText", { text: `Renamed from ${origin}` });
        await b.key("Enter");
        await b.poll(
          `!document.querySelector('.otk-title-editor') && document.querySelector('[data-session="${session.id}"] .otk-row-title')?.textContent==='Renamed from ${origin}'`,
        );
        assertEquals(
          (await f.oc.request<{ title: string }>(`/session/${session.id}`))
            .title,
          `Renamed from ${origin}`,
        );
      }
      await sessionContext(b, `[data-session="${session.id}"]`);
      await b.click(`${menu} [data-context-command="session.rename"]`);
      await b.poll(
        `document.activeElement?.matches('.otk-title-editor input')`,
      );
      await b.send("Input.insertText", { text: "Cancelled title" });
      await b.key("Escape");
      await b.poll("!document.querySelector('.otk-title-editor')");
      await sessionContext(b, `[data-session="${session.id}"]`);
      await b.click(`${menu} [data-context-command="session.rename"]`);
      await b.poll(
        `document.activeElement?.matches('.otk-title-editor input')`,
      );
      await b.key("Backspace");
      await b.key("Enter");
      await b.poll("!document.querySelector('.otk-title-editor')");
      await sessionContext(b, `[data-session="${session.id}"]`);
      await b.click(`${menu} [data-context-command="session.rename"]`);
      await b.poll(
        `document.activeElement?.matches('.otk-title-editor input')`,
      );
      await b.send("Input.insertText", { text: "Committed on blur" });
      await b.click(".otk-prompt textarea");
      await b.poll(
        `!document.querySelector('.otk-title-editor') && document.querySelector('[data-session="${session.id}"] .otk-row-title')?.textContent==='Committed on blur'`,
      );
      await b.reload();
      await openSession(b, session.id);
      assertEquals(
        await b.evaluate(
          `document.querySelector('[data-session="${session.id}"] .otk-row-title').textContent`,
        ),
        "Committed on blur",
      );
      assertEquals(b.errors, []);
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}
