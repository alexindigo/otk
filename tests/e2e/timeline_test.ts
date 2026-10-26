// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { sentFrames } from "../support/browser-fixture.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`Timeline reveals and focuses prompts, shares hover/context actions and follows rollback (${theme})`, async () => {
    const f = await browserFixture();
    let client: WsClient | undefined;
    try {
      const s = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Timeline review" },
      });
      const server = await f.sidecar();
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      const b = await f.browser(server.url);
      await openSession(b, s.id);
      const prompts = [
        "Trace the session action owners",
        "Keep the transcript as the only content store",
        "Verify the final consumer outcome",
      ];
      for (const text of prompts) {
        const reply = Array(18).fill(`Response to ${text}.`).join(" ");
        f.fake.queue({ chunks: [reply] });
        await b.fill("textarea[name=prompt]", text);
        await b.key("Enter");
        await waitForReply(b, s.id, reply);
      }
      f.fake.queue({ chunks: ["Timeline compaction summary."] });
      await b.key("k", 2);
      await b.poll(
        "!!document.querySelector('[data-command=\"session.compact\"]')",
      );
      await b.click('[data-command="session.compact"]');
      await waitForReply(b, s.id, "Timeline compaction summary.");
      await b.poll(
        "document.querySelector('.otk-compaction-divider')?.textContent==='Session compacted'",
      );
      await b.evaluate("document.fonts.ready.then(()=>true)");
      const sessionGeometry = await b.evaluate<
        { left: number; text: number; height: number }
      >(
        `(()=>{const row=document.querySelector('[data-session="${s.id}"]'),box=row.getBoundingClientRect(),text=row.querySelector('.otk-row-title').getBoundingClientRect();return {left:box.left,text:text.left,height:box.height}})()`,
      );
      await b.poll("!!document.querySelector('[data-panel-view=timeline]')");
      await b.click("[data-panel-view=timeline]");
      await b.poll(
        "document.querySelectorAll('[data-timeline-prompt]').length>0",
      );
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('[data-timeline-prompt]')].map(row=>row.dataset.timelinePrompt)",
        ),
        await b.evaluate(
          "[...document.querySelectorAll('[data-role=user]')].filter(message=>message.querySelector('.otk-user-bubble')).map(message=>message.dataset.message)",
        ),
        "Timeline rows are exactly the visible prompt bubbles, never marker-only messages",
      );
      await b.poll(
        "document.querySelectorAll('[data-timeline-prompt]').length===3",
      );
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('.otk-timeline-preview')].map(e=>e.textContent)",
        ),
        prompts,
      );
      const ids = await b.evaluate<string[]>(
        "[...document.querySelectorAll('[data-timeline-prompt]')].map(e=>e.dataset.timelinePrompt)",
      );
      const first = `[data-timeline-prompt="${ids[0]}"]`;
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 0,
        y: 0,
      });
      const rowGeometry = await b.evaluate<
        { left: number; text: number; height: number; shared: boolean }
      >(
        `(()=>{const row=document.querySelector('${first}'),box=row.getBoundingClientRect(),text=row.querySelector('.otk-timeline-preview').getBoundingClientRect();return {left:box.left,text:text.left,height:box.height,shared:row.classList.contains('otk-list-row')}})()`,
      );
      console.info("TIMELINE_LIST_ROW_GEOMETRY", theme, {
        session: sessionGeometry,
        timeline: rowGeometry,
      });
      assertEquals(
        rowGeometry,
        { ...sessionGeometry, shared: true },
        "Same shared row height, highlight box and text edge as Sessions",
      );
      const buttonRects = () =>
        b.evaluate<number[][]>(
          `[...document.querySelectorAll('${first} [data-message-command]')].map(button=>{const r=button.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})`,
        );
      const atRest = await buttonRects();
      await b.poll(
        `getComputedStyle(document.querySelector('${first} time')).visibility==='visible' && getComputedStyle(document.querySelector('${first} [data-message-command]')).visibility==='hidden'`,
      );
      const hoverPoint = await b.evaluate<{ x: number; y: number }>(
        `(()=>{const r=document.querySelector('${first} .otk-timeline-reveal').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...hoverPoint,
      });
      await b.poll(
        `getComputedStyle(document.querySelector('${first} time')).visibility==='hidden' && getComputedStyle(document.querySelector('${first} [data-message-command]')).visibility==='visible'`,
      );
      assertEquals(
        await buttonRects(),
        atRest,
        "Hover cannot move action hit targets",
      );
      assertEquals(
        await b.evaluate(
          `getComputedStyle(document.querySelector('${first} .otk-timeline-reveal')).backgroundColor`,
        ),
        "rgba(0, 0, 0, 0)",
        "Only the shared row paints the hover highlight",
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 0,
        y: 0,
      });
      await b.poll(
        `getComputedStyle(document.querySelector('${first} time')).visibility==='visible' && getComputedStyle(document.querySelector('${first} [data-message-command]')).visibility==='hidden'`,
      );
      assertEquals(
        await buttonRects(),
        atRest,
        "Leaving cannot move action hit targets",
      );
      await b.evaluate(
        `document.querySelector('${first} .otk-timeline-reveal').focus()`,
      );
      await b.poll(
        `getComputedStyle(document.querySelector('${first} time')).visibility==='hidden' && getComputedStyle(document.querySelector('${first} [data-message-command]')).visibility==='visible'`,
      );
      assertEquals(
        await buttonRects(),
        atRest,
        "Focus cannot move action hit targets",
      );
      for (const id of ids) {
        await b.click(`[data-timeline-prompt="${id}"] .otk-timeline-reveal`);
        await b.poll(
          `(()=>{const bubble=document.querySelector('[data-message="${id}"] .otk-user-bubble'),viewport=document.querySelector('.otk-messages');if(!bubble)return false;const a=bubble.getBoundingClientRect(),v=viewport.getBoundingClientRect();return document.activeElement===bubble && a.top>=v.top-.5 && a.bottom<=v.bottom+.5})()`,
        );
      }
      const row = `[data-timeline-prompt="${ids[0]}"]`;
      await b.click(`${row} .otk-timeline-reveal`);
      await b.poll(
        `(()=>{const bubble=document.querySelector('[data-message="${
          ids[0]
        }"] .otk-user-bubble'), viewport=document.querySelector('.otk-messages');if(!bubble)return false;const a=bubble.getBoundingClientRect(),v=viewport.getBoundingClientRect();return document.activeElement===bubble && a.top>=v.top-.5 && a.bottom<=v.bottom+.5})()`,
      );
      assertEquals(
        await b.evaluate(
          `${
            JSON.stringify(ids[0])
          }===document.querySelector('[data-timeline-prompt].is-selected')?.dataset.timelinePrompt`,
        ),
        true,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 0,
        y: 0,
      });
      await b.poll(
        `getComputedStyle(document.querySelector('${row} time')).visibility==='hidden' && getComputedStyle(document.querySelector('${row} [data-message-command]')).visibility==='visible'`,
      );
      const point = await b.evaluate<{ x: number; y: number }>(
        `(()=>{const r=document.querySelector('${row} .otk-timeline-reveal').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await b.poll(
        `getComputedStyle(document.querySelector('${row} .otk-message-actions')).opacity==='1'`,
      );
      assertEquals(
        await b.evaluate(
          `[...document.querySelectorAll('${row} [data-message-command]')].map(e=>e.dataset.messageCommand)`,
        ),
        ["prompt.revert", "prompt.copy"],
      );
      await b.evaluate(
        "globalThis.timelineCopied='';navigator.clipboard.writeText=async text=>{globalThis.timelineCopied=text}",
      );
      await b.click(`${row} [data-message-command="prompt.copy"]`);
      await b.poll(`globalThis.timelineCopied===${JSON.stringify(prompts[0])}`);
      await b.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "right",
        buttons: 2,
        clickCount: 1,
      });
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "right",
        buttons: 0,
        clickCount: 1,
      });
      await b.poll(
        "!!document.querySelector('[data-context-command=\"prompt.revert\"]')",
      );
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent).slice(0,2)",
        ),
        ["Copy prompt", "Revert to here"],
      );
      const shots = Deno.env.get("OTK_TIMELINE_SCREENSHOTS");
      if (shots) await b.screenshot(join(shots, `${theme}-timeline-menu.png`));
      await b.key("Escape");
      // Re-select after the menu so the frame shows the actual reveal result.
      await b.click(`${row} .otk-timeline-reveal`);
      if (shots) await b.screenshot(join(shots, `${theme}-timeline-panel.png`));
      const geometry = await b.evaluate<number[]>(
        "[...document.querySelectorAll('[data-timeline-prompt]')].map(e=>{const p=e.querySelector('.otk-timeline-preview').getBoundingClientRect(),t=e.querySelector('time').getBoundingClientRect();return Math.abs(p.y+p.height/2-t.y-t.height/2)})",
      );
      assert(geometry.every((n) => n < .5));
      await b.click(`${row} [data-message-command="prompt.revert"]`);
      await b.poll(
        "document.querySelectorAll('[data-timeline-prompt]').length===0 && document.querySelector('.otk-rolled-back-strip strong')?.textContent==='4 prompts rolled back'",
      );
      await b.click(".otk-rollback-disclosure");
      await b.click(".otk-rollback-footer button");
      await b.poll(
        "document.querySelectorAll('[data-timeline-prompt]').length===3 && !document.querySelector('.otk-rolled-back-strip')",
      );
      await b.reload();
      await b.poll(
        "document.querySelectorAll('[data-timeline-prompt]').length===3",
      );
      assertEquals(b.errors, []);
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}

test("Timeline pages the same transcript and clears on project-only selection", async () => {
  const f = await browserFixture();
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Paged prompts" },
    });
    for (let i = 0; i < 105; i++) {
      await f.oc.request(`/session/${s.id}/message`, {
        method: "POST",
        body: {
          noReply: true,
          parts: [{ type: "text", text: `Historical prompt ${i}` }],
        },
      });
    }
    const server = await f.sidecar(), b = await f.browser(server.url);
    await openSession(b, s.id);
    await b.click("[data-panel-view=timeline]");
    await b.poll(
      "document.querySelectorAll('[data-timeline-prompt]').length===100 && !!document.querySelector('.otk-timeline-older')",
    );
    const before = sentFrames(b).length;
    await b.click(".otk-timeline-older");
    await b.poll(
      "document.querySelectorAll('[data-timeline-prompt]').length===105 && document.querySelectorAll('[data-role=user]').length===105 && !document.querySelector('.otk-timeline-older')",
    );
    assert(
      sentFrames(b).slice(before).some(({ frame }) =>
        frame.method === "session.messages" &&
        !!(frame.params as { before?: string }).before
      ),
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-timeline-preview').textContent",
      ),
      "Historical prompt 0",
    );
    await b.goto(
      `${server.url}/#project/local/${encodeURIComponent(f.oc.directory)}`,
    );
    await b.poll(
      "document.querySelector('.otk-timeline')?.textContent.includes('Open a session to see its prompts.') && document.querySelectorAll('[data-timeline-prompt]').length===0",
    );
    assertEquals(b.errors, []);
  } finally {
    await f.stop();
  }
});
