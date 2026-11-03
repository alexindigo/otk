// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { test } from "../support/resources.ts";
import {
  legacyStaticMessages,
  visualText,
} from "../support/legacy-message-scene.ts";

for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`Timeline reveals and focuses prompts, shares hover/context actions and follows rollback (${theme})`, () =>
    legacyStaticMessages(
      theme,
      () =>
        [0, 1, 2].map((i) => ({
          id: `prompt-${i}`,
          sessionID: "tstv1-core",
          role: "user",
          time: { created: 1000 + i },
          parts: [visualText(`text-${i}`, `Fixed Timeline prompt ${i}`)],
        })),
      async ({ b, set }) => {
        await set("shellLayout", {
          leftWidth: 248,
          leftCollapsed: false,
          rightCollapsed: false,
          rightWidth: 320,
          rightView: "sessions",
          projectLocations: [],
        });
        await b.poll("!!document.querySelector('[data-session=tstv1-core]')");
        const session = await b.evaluate(
          "(()=>{const e=document.querySelector('[data-session=tstv1-core]'),r=e.getBoundingClientRect(),t=e.querySelector('.otk-row-title').getBoundingClientRect();return {left:r.left,text:t.left,height:r.height}})()",
        );
        await b.click("[data-panel-view=timeline]");
        await b.poll(
          "document.querySelectorAll('[data-timeline-prompt]').length===3",
        );
        const first = '[data-timeline-prompt="prompt-0"]';
        await b.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 0,
          y: 0,
        });
        assertEquals(
          await b.evaluate(
            `(()=>{const e=document.querySelector('${first}'),r=e.getBoundingClientRect(),t=e.querySelector('.otk-timeline-preview').getBoundingClientRect();return {left:r.left,text:t.left,height:r.height}})()`,
          ),
          session,
        );
        const rects = () =>
          b.evaluate(
            `Array.from(document.querySelectorAll('${first} [data-message-command]'),e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})`,
          );
        const fixed = await rects();
        await b.poll(
          `getComputedStyle(document.querySelector('${first} time')).visibility==='visible'&&getComputedStyle(document.querySelector('${first} [data-message-command]')).visibility==='hidden'`,
        );
        const p = await b.evaluate<{ x: number; y: number }>(
          `(()=>{const r=document.querySelector('${first} .otk-timeline-reveal').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...p });
        await b.poll(
          `getComputedStyle(document.querySelector('${first} time')).visibility==='hidden'&&getComputedStyle(document.querySelector('${first} [data-message-command]')).visibility==='visible'`,
        );
        assertEquals(await rects(), fixed);
        assertEquals(
          await b.evaluate(
            `getComputedStyle(document.querySelector('${first} .otk-timeline-reveal')).backgroundColor`,
          ),
          "rgba(0, 0, 0, 0)",
        );
        await b.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 0,
          y: 0,
        });
        await b.poll(
          `getComputedStyle(document.querySelector('${first} time')).visibility==='visible'`,
        );
        assertEquals(await rects(), fixed);
        await b.evaluate(
          `document.querySelector('${first} .otk-timeline-reveal').focus()`,
        );
        await b.poll(
          `getComputedStyle(document.querySelector('${first} time')).visibility==='hidden'`,
        );
        assertEquals(await rects(), fixed);
        const geometry = await b.evaluate<number[]>(
          "[...document.querySelectorAll('[data-timeline-prompt]')].map(e=>{const a=e.querySelector('.otk-timeline-preview').getBoundingClientRect(),b=e.querySelector('time').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)})",
        );
        assert(geometry.every((n) => n < .5));
      },
      {
        capabilities: {
          revert: {
            revert: () =>
              Promise.reject(new Error("Fixed paint has no mutation")),
          },
        },
      },
    ));
}
