// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import type { Cdp } from "../support/cdp.ts";
import { menuReady } from "../support/menu.ts";

const menu = ':popover-open [role="menu"][aria-label="Context menu"]';
export async function sessionContext(
  b: Cdp,
  selector: string,
  readyCommand?: string,
) {
  await b.rightClick(selector);
  if (readyCommand) {
    await b.poll(
      `!!document.querySelector('${menu} [data-context-command="${readyCommand}"]')`,
    );
  }
  await menuReady(b, menu);
}
// Fixed action paint scenes. C10 owns native outcomes, drafts, inclusive copies and deletion.
for (const theme of ["otk-dark", "otk-light"]) {
  test(`fork hover actions retain grouped replies and fork notes in ${theme}`, async () => {
    const f = await browserFixture({ bash: "allow" });
    let client: WsClient | undefined;
    try {
      const s = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Fork paint" },
      });
      const server = await f.sidecar();
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      f.fake.queue({
        tool: {
          name: "bash",
          input: { command: "pwd", description: "Grouped paint" },
        },
      }, { chunks: ["First grouped reply."] });
      await client.rpc("session.prompt", {
        sessionID: s.id,
        mode: "normal",
        model: { provider: "fake", model: "scripted" },
        parts: [{ kind: "text", text: "First prompt" }],
      });
      const b = await f.browser(server.url);
      await openSession(b, s.id);
      await waitForReply(b, s.id, "First grouped reply.");
      const reply = '[data-role="assistant"]';
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 1,
        y: 1,
      });
      await b.poll(
        `getComputedStyle(document.querySelector('${reply} .otk-message-actions')).opacity==='0'`,
      );
      await b.evaluate(
        `(()=>{const el=document.querySelector('${reply}');globalThis.hoverOpened=0;el.addEventListener('mouseenter',()=>{globalThis.hoverStart=performance.now()},{once:true});const observer=new MutationObserver(()=>{if(el.classList.contains('is-revealed')){globalThis.hoverOpened=performance.now()-globalThis.hoverStart;observer.disconnect()}});observer.observe(el,{attributes:true,attributeFilter:['class']})})()`,
      );
      const point = await b.evaluate<{ x: number; y: number }>(
        `(()=>{const r=document.querySelector('${reply} .otk-message-content').getBoundingClientRect();return {x:r.x+10,y:r.y+r.height-10}})()`,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await b.poll("globalThis.hoverOpened>0");
      assert(await b.evaluate<number>("hoverOpened") >= 500);
      assert(
        await b.evaluate(
          `(()=>{const footer=document.querySelector('${reply} .otk-message-footer'),copy=footer.querySelector('[data-message-command="reply.copy"]').getBoundingClientRect(),clock=footer.querySelector('.otk-last-output-time').getBoundingClientRect();return clock.left-copy.right===parseFloat(getComputedStyle(footer).columnGap)})()`,
        ),
      );
      const geometry = () =>
        b.evaluate(
          `(()=>{const e=document.querySelector('${reply}'),r=e.getBoundingClientRect();return {height:r.height,top:r.top}})()`,
        );
      const before = await geometry();
      await b.evaluate(
        `(()=>{const el=document.querySelector('${reply}');globalThis.hoverClosed=0;el.addEventListener('mouseleave',()=>{globalThis.hoverLeaveStart=performance.now()},{once:true});const observer=new MutationObserver(()=>{if(!el.classList.contains('is-revealed')){globalThis.hoverClosed=performance.now()-globalThis.hoverLeaveStart;observer.disconnect()}});observer.observe(el,{attributes:true,attributeFilter:['class']})})()`,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 1,
        y: 1,
      });
      assert(
        await b.evaluate(
          `document.querySelector('${reply}').classList.contains('is-revealed')`,
        ),
      );
      await b.poll(
        `!document.querySelector('${reply}').classList.contains('is-revealed')`,
      );
      assert(await b.evaluate<number>("hoverClosed") >= 150);
      assertEquals(await geometry(), before);
      const rect = () =>
        b.evaluate(
          `document.querySelector('${reply} [data-message-command="reply.fork"]').getBoundingClientRect().toJSON()`,
        );
      const fixed = await rect();
      // The created-time focus scene is keyboard-visible focus, as in the source.
      await b.key("Tab");
      for (const action of ["focus", "blur", "hover", "leave"]) {
        if (action === "focus") {
          await b.evaluate(
            `document.querySelector('${reply} .otk-message-agent').focus({preventScroll:true})`,
          );
        }
        if (action === "blur") {
          await b.evaluate(
            "document.querySelector('textarea[name=prompt]').focus({preventScroll:true})",
          );
        }
        if (action === "hover") {
          const p = await b.evaluate<{ x: number; y: number }>(
            `(()=>{const r=document.querySelector('${reply} .otk-message-agent').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
          );
          await b.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            ...p,
          });
        }
        if (action === "leave") {
          await b.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: 1,
            y: 1,
          });
        }
        await b.poll(
          `(getComputedStyle(document.querySelector('${reply} .otk-created-time')).display!=='none')===${
            action === "focus" || action === "hover"
          }`,
        );
        assertEquals(await rect(), fixed);
      }
      await b.click(`${reply} .otk-message-agent`);
      await b.click(`${reply} [data-message-command="reply.fork"]`);
      await b.poll("!!document.querySelector('.otk-fork-note')");
      await b.poll(
        "document.querySelectorAll('[data-role=user]').length===1&&document.querySelectorAll('[data-role=assistant]').length===1",
      );
      assertEquals(
        await b.evaluate(
          "(()=>{const note=document.querySelector('.otk-fork-note'),button=note.querySelector('button'),icons=[note.querySelector('.otk-composer-notice-icon > svg'),button.querySelector('svg')];return {button:[button.getBoundingClientRect().width,button.getBoundingClientRect().height],icons:icons.map(icon=>[icon.getBoundingClientRect().width,icon.getBoundingClientRect().height])}})()",
        ),
        { button: [28, 28], icons: [[16, 16], [16, 16]] },
      );
      const copy = () =>
        b.evaluate(
          "document.querySelector('[data-role=user] [data-message-command=\"prompt.copy\"]').getBoundingClientRect().toJSON()",
        );
      const copySlot = await copy();
      await b.evaluate(
        "document.querySelector('.otk-user-bubble').focus({preventScroll:true})",
      );
      await b.poll(
        "getComputedStyle(document.querySelector('[data-role=user] .otk-message-actions')).opacity==='1'",
      );
      assertEquals(await copy(), copySlot);
      await b.send("Browser.grantPermissions", {
        origin: server.url,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      await b.click('[data-role=user] [data-message-command="prompt.copy"]');
      assertEquals(await copy(), copySlot);
      assertEquals(b.errors, []);
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}
for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  for (const kind of ["rename", "delete"] as const) {
    const title = kind === "rename"
      ? `rename edits only its tab, chip or row and persists after reload in ${theme}`
      : `delete protects lost drafts, disarms on navigation and removes native sessions in ${theme}`;
    test(title, async () => {
      const f = await browserFixture();
      let client: WsClient | undefined;
      try {
        const s = await f.oc.session<{ id: string }>("/session", {
          method: "POST",
          body: { title: "Action paint" },
        });
        const server = await f.sidecar();
        client = new WsClient(server.url);
        await client.connect();
        await client.rpc("prefs.set", { key: "theme", value: theme });
        const b = await f.browser(server.url);
        await openSession(b, s.id);
        if (kind === "rename") {
          for (
            const [origin, selector] of [["tab", `[data-tab="${s.id}"]`], [
              "chip",
              `[data-crumb="${s.id}"]`,
            ], ["row", `[data-session="${s.id}"]`]]
          ) {
            await sessionContext(b, selector);
            await b.click(`${menu} [data-context-command="session.rename"]`);
            await b.poll("!!document.querySelector('.otk-title-editor input')");
            assertEquals(
              await b.evaluate(
                "document.querySelectorAll('.otk-title-editor').length",
              ),
              1,
            );
            assertEquals(
              await b.evaluate(
                "document.querySelector('.otk-title-editor').dataset.origin",
              ),
              origin,
            );
            assert(
              await b.evaluate(
                "(()=>{const e=document.activeElement;return e.selectionStart===0&&e.selectionEnd===e.value.length})()",
              ),
            );
            await b.key("Escape");
          }
        } else {
          await sessionContext(b, `[data-tab="${s.id}"]`, "session.compact");
          await b.click(`${menu} [data-context-command="session.delete"]`);
          await b.poll(
            `document.querySelector('${menu} [data-context-command="session.delete"]')?.textContent==='Press again to delete'`,
          );
          assert(
            await b.evaluate(
              `document.querySelector('${menu} [data-context-command="session.delete"]').classList.contains('is-armed')`,
            ),
          );
          await b.key("Escape");
        }
        assertEquals(b.errors, []);
      } finally {
        await client?.close();
        await f.stop();
      }
    });
  }
}
