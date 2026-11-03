// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { legacySessionsScene } from "../support/legacy-sessions-scene.ts";

test("shipped summaries update rows and footers without detail; deletion retains task and opens metadata-only details", async () => {
  const f = await browserFixture();
  let c: WsClient | undefined;
  try {
    const s = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Digest paint" },
    });
    const server = await f.sidecar();
    c = new WsClient(server.url);
    await c.connect();
    f.fake.queue({ chunks: ["A digested reply."] });
    await c.rpc("session.prompt", {
      sessionID: s.id,
      mode: "normal",
      model: { provider: "fake", model: "scripted" },
      parts: [{ kind: "text", text: "Fixed summary scene" }],
    });
    const b = await f.browser(server.url);
    await openSession(b, s.id);
    await waitForReply(b, s.id, "A digested reply.");
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const gaps = await b.evaluate<number[]>(
        "[...document.querySelectorAll('.otk-session-row')].flatMap(e=>{const ys=['.otk-list-row-leading','.otk-list-row-label','.otk-list-row-trailing'].map(s=>{const r=e.querySelector(s).getBoundingClientRect();return r.y+r.height/2});return ys.map(y=>Math.abs(y-ys[0]))})",
      );
      assertEquals(gaps.every((n) => n <= 1), true);
      const icon = await b.evaluate<number[]>(
        "(()=>{const c=document.querySelector('.otk-panel-new-session').getBoundingClientRect(),i=document.querySelector('.otk-panel-new-session svg').getBoundingClientRect();return [i.left-c.left,c.right-i.right,i.top-c.top,c.bottom-i.bottom]})()",
      );
      assertEquals(Math.max(...icon) - Math.min(...icon) <= 1, true);
    }
    await f.oc.request(`/session/${s.id}`, { method: "DELETE" });
    await b.poll("!!document.querySelector('.otk-deleted-session')");
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const contrast = await b.evaluate<number[]>(
        `(()=>{const css=getComputedStyle(document.documentElement),title=document.querySelector('[data-session="${s.id}"] .otk-row-title'),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d'),rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=css.getPropertyValue('--otk-bg-side');ctx.fillRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(n=>n/255)},lum=color=>rgb(color).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0),fg=lum(getComputedStyle(title).color);return ['--otk-bg','--otk-bg-side','--otk-selected'].map(key=>{const bg=lum(css.getPropertyValue(key));return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)})})()`,
      );
      assertEquals(contrast.every((n) => n >= 4.5), true);
    }
  } finally {
    await c?.close();
    await f.stop();
  }
});
for (const theme of ["otk-dark", "otk-light"]) {
  test(`unknown summaries and rejected detail never render a fictitious zero ledger (${theme})`, () =>
    legacySessionsScene("contract-sessions-unknown", theme, async ({ b }) => {
      await b.poll(
        "document.querySelector('.otk-turn-usage-trigger')?.textContent.includes('Tokens unavailable')&&document.querySelector('.otk-turn-usage-trigger').textContent.includes('Cost unavailable')",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-message-footer').textContent.includes('$0.00')",
        ),
        false,
      );
    }, "tstv1-core"));
}
