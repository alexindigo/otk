// SPDX-License-Identifier: LGPL-3.0-only
// T2 fixed timestamp V scenes; native completion/SQLite/restart is in Playwright.
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { legacyMessageScene } from "../support/legacy-message-scene.ts";
for (const theme of ["otk-dark", "otk-light"]) {
  test(`creation-time hover and persistent visibility, structural footer date/clock, native final time and completed restart in ${theme}`, () =>
    legacyMessageScene(
      "contract-messages-clock",
      theme,
      async ({ b, capture, set }) => {
        await b.poll("!!document.querySelector('.otk-last-output-time')");
        await b.evaluate(
          "document.querySelector('.otk-last-output-time').scrollIntoView({block:'center',behavior:'instant'})",
        );
        await capture("timestamps-default");
        const before = await b.evaluate<{ left: number; right: number }>(
          "(()=>{const r=document.querySelector('.otk-last-output-time').getBoundingClientRect();return{left:r.left,right:r.right}})()",
        );
        assertEquals(
          await b.evaluate(
            "getComputedStyle(document.querySelector('.otk-last-output-date')).visibility",
          ),
          "hidden",
        );
        const point = await b.evaluate<{ x: number; y: number }>(
          "(()=>{const r=document.querySelector('.otk-last-output-time').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()",
        );
        await b.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
        });
        await b.poll(
          "getComputedStyle(document.querySelector('.otk-last-output-date')).visibility==='visible'",
        );
        const g = await b.evaluate<
          {
            dateRight: number;
            timeLeft: number;
            timeRight: number;
            dateCenter: number;
            timeCenter: number;
            date: string;
            expected: string;
          }
        >("(()=>{const d=document.querySelector('.otk-last-output-date'),t=document.querySelector('.otk-last-output-time'),a=d.getBoundingClientRect(),z=t.getBoundingClientRect();return{dateRight:a.right,timeLeft:z.left,timeRight:z.right,dateCenter:a.y+a.height/2,timeCenter:z.y+z.height/2,date:d.textContent.trim(),expected:new Date(t.dateTime).toLocaleDateString()}})()");
        assertEquals(g.date, g.expected);
        assert(
          g.dateRight < g.timeLeft &&
            Math.abs(g.dateCenter - g.timeCenter) < .5 &&
            Math.abs(g.timeLeft - before.left) < .5 &&
            Math.abs(g.timeRight - before.right) < .5,
        );
        await capture("timestamps-output-date");
        await b.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 10,
          y: 10,
        });
        for (const role of ["user", "assistant"]) {
          const trigger = `[data-role=${role}] .otk-created-trigger`;
          await b.evaluate(
            `document.querySelector('${trigger}').scrollIntoView({block:'center',behavior:'instant'})`,
          );
          const p = await b.evaluate<{ x: number; y: number }>(
            `(()=>{const r=document.querySelector('${trigger}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
          );
          await b.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            ...p,
          });
          await b.poll(
            `getComputedStyle(document.querySelector('[data-role=${role}] .otk-created-time')).visibility==='visible'`,
          );
          await capture(`timestamps-hover-${role}`);
          await b.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: 10,
            y: 10,
          });
          await b.poll(
            `getComputedStyle(document.querySelector('[data-role=${role}] .otk-created-time')).visibility==='hidden'`,
          );
        }
        const style = await b.evaluate<
          {
            right: number;
            details: number;
            timeLeft: number;
            color: boolean;
            created: number;
            role: number;
          }
        >(`(()=>{const footer=document.querySelector('.otk-message-footer'),t=footer.querySelector('.otk-last-output-time'),d=footer.querySelector('.otk-message-details'),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d'),color=el=>{ctx.clearRect(0,0,1,1);const layers=[];for(let n=el;n;n=n.parentElement)layers.unshift(n);for(const n of layers){ctx.fillStyle=getComputedStyle(n).backgroundColor;ctx.fillRect(0,0,1,1)}ctx.fillStyle=getComputedStyle(el).color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).reduce((a,b)=>a+b,0)};return{right:Math.abs(footer.getBoundingClientRect().right-t.getBoundingClientRect().right),details:d.getBoundingClientRect().right,timeLeft:t.getBoundingClientRect().left,color:getComputedStyle(footer).color===getComputedStyle(t).color,created:color(document.querySelector('.otk-created-time')),role:color(document.querySelector('.otk-created-trigger'))}})()`);
        assert(
          style.right < .5 && style.details < style.timeLeft && style.color,
        );
        assert(
          theme === "otk-dark"
            ? style.created < style.role
            : style.created > style.role,
        );
        await set("timestamps", true);
        await b.poll(
          "[...document.querySelectorAll('.otk-created-time')].every(e=>getComputedStyle(e).visibility==='visible')",
        );
        await capture("timestamps-always");
      },
      "tstv1-core",
    ));
}
