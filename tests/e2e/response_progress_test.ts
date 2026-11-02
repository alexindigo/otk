// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import {
  legacyStaticMessages,
  visualReply,
  visualText,
} from "../support/legacy-message-scene.ts";
test("U3 response progress follows streaming content, motion preferences, completion and interruption", async () => {
  const earlier = visualReply("earlier", [
    visualText("earlier-text", "An earlier reply is finished."),
  ], { replyTo: "earlier-prompt" });
  const current = (done = false, interrupted = false) =>
    visualReply("reply", [
      visualText(
        "text",
        "The response is still arriving. More content follows here.",
      ),
    ], {
      time: { created: 7000, ...(done ? { completed: 9000 } : {}) },
      interrupted,
    });
  for (const theme of ["otk-dark", "otk-light"]) {
    await legacyStaticMessages(
      theme,
      () => [earlier, current()],
      async ({ b, set, replace, capture }) => {
        await set("animationsOff", false);
        await b.send("Emulation.setEmulatedMedia", {
          features: [{
            name: "prefers-reduced-motion",
            value: "no-preference",
          }],
        });
        await b.poll(
          "document.querySelectorAll('.otk-response-progress').length===1",
        );
        const geometry = await b.evaluate<
          {
            bottom: boolean;
            flow: string;
            width: number;
            contentWidth: number;
            height: number;
            previous: number;
          }
        >("(()=>{const a=document.querySelector('[data-message=reply]'),c=a.querySelector('.otk-message-content'),p=c.querySelector('.otk-response-progress'),g=p.querySelector('.otk-response-glimmer'),r=p.getBoundingClientRect(),last=p.previousElementSibling.getBoundingClientRect(),f=a.querySelector('footer').getBoundingClientRect();return {bottom:c.lastElementChild===p&&r.top>=last.bottom&&r.bottom<=f.top,flow:getComputedStyle(p).position,width:g.getBoundingClientRect().width,contentWidth:c.getBoundingClientRect().width,height:g.getBoundingClientRect().height,previous:document.querySelector('[data-message=earlier]').querySelectorAll('.otk-response-progress').length}})()");
        assert(geometry.bottom);
        assertEquals(geometry.flow, "static");
        assertEquals(geometry.width, geometry.contentWidth);
        assertEquals(geometry.height, 2);
        assertEquals(geometry.previous, 0);
        await capture("streaming");
        const staticVisible =
          "(()=>{const p=document.querySelector('.otk-response-progress'),g=p?.querySelector('.otk-response-glimmer'),t=p?.querySelector('.otk-response-progress-text');return p&&getComputedStyle(g).display==='none'&&getComputedStyle(g).animationName==='none'&&getComputedStyle(t).display==='flex'&&t.getBoundingClientRect().height===20&&t.textContent.trim()==='response in progress'})()";
        await b.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: "reduce" }],
        });
        await b.poll(staticVisible);
        await capture("reduced-motion");
        await b.send("Emulation.setEmulatedMedia", {
          features: [{
            name: "prefers-reduced-motion",
            value: "no-preference",
          }],
        });
        await set("animationsOff", true);
        await b.poll(staticVisible);
        await capture("animations-off");
        await replace([earlier, current(true)]);
        await b.poll("!document.querySelector('.otk-response-progress')");
        await capture("complete");
        await replace([earlier, current(true, true)]);
        await b.poll(
          "document.querySelector('[data-message=reply] footer')?.textContent.includes('interrupted')",
        );
        await capture("interrupted");
      },
    );
  }
});
