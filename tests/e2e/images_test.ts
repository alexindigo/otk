// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`U8 pasted and dropped images have one independent chip, persist as loaded message thumbnails and open the original in Dialog in ${theme}`, async () => {
    const f = await browserFixture();
    let client: WsClient | undefined;
    try {
      const session = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Image scenes" },
      });
      const server = await f.sidecar(), b = await f.browser(server.url);
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await client.rpc("prefs.set", { key: "animationsOff", value: true });
      await openSession(b, session.id);
      const image = await b.evaluate<string>(
        "(()=>{const c=document.createElement('canvas');c.width=640;c.height=400;const x=c.getContext('2d');x.fillStyle='#234651';x.fillRect(0,0,640,400);x.fillStyle='#7fc8b8';x.fillRect(40,40,240,240);x.fillStyle='#f2c16d';x.beginPath();x.arc(440,160,100,0,Math.PI*2);x.fill();x.fillStyle='#ffffff';x.font='24px sans-serif';x.fillText('Image review · 640 × 400',40,350);return c.toDataURL('image/png')})()",
      );
      await f.oc.request(`/session/${session.id}/message`, {
        method: "POST",
        body: {
          noReply: true,
          parts: [{ type: "text", text: "Describe these shapes." }, {
            type: "file",
            filename: "sample.png",
            mime: "image/png",
            url: image,
          }],
        },
      });
      await b.reload();
      await b.poll(
        "(()=>{const i=document.querySelector('[data-role=user] .otk-file-image img');return i?.complete && i.naturalWidth===640})()",
      );
      await b.fill("textarea[name=prompt]", "What is in this image?");
      await b.evaluate(
        `(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob(${
          JSON.stringify(image.split(",")[1])
        }),c=>c.charCodeAt(0))],'sample.png',{type:'image/png'}));document.querySelector('textarea[name=prompt]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:d}));})()`,
      );
      await b.poll(
        "document.querySelectorAll('.otk-prompt-chip').length===1 && document.querySelector('.otk-prompt-chip img')?.naturalWidth===640",
      );
      assertEquals(
        await b.evaluate("document.querySelector('.otk-prompt-chip img').src"),
        image,
      );
      assert(
        await b.evaluate(
          "(()=>{const i=document.querySelector('.otk-prompt-chip img').getBoundingClientRect(),r=document.querySelector('.otk-prompt-chip button:last-child').getBoundingClientRect();return Math.abs(i.y+i.height/2-r.y-r.height/2)<.5})()",
        ),
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('[data-role=user] .otk-file-image img').src",
        ),
        image,
      );
      await b.click(".otk-file-image");
      await b.poll(
        "document.querySelector('dialog[open] .otk-image-view img')?.naturalWidth===640",
      );
      assertEquals(
        await b.evaluate("document.querySelector('dialog[open] img').src"),
        image,
      );
      assert(
        await b.evaluate(
          "(()=>{const t=document.querySelector('.otk-file-image img').getBoundingClientRect(),i=document.querySelector('dialog[open] img').getBoundingClientRect();return i.width>t.width && Math.abs(i.width/i.height-1.6)<.01 && document.querySelectorAll('dialog[open] h2').length===1})()",
        ),
      );
      await b.key("Escape");
      await b.poll(
        "!document.querySelector('dialog[open]') && document.activeElement===document.querySelector('.otk-file-image')",
      );
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}
