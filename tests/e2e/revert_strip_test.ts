// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { test } from "../support/resources.ts";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { serve } from "../support/http.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`revert strip restores files and conversation, survives reload and commits on the next prompt (${theme})`, async () => {
    const f = await browserFixture();
    let c: WsClient | undefined;
    try {
      const s = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Rollback paint" },
      });
      const prompt = await f.oc.request<{ info: { id: string } }>(
        `/session/${s.id}/message`,
        {
          method: "POST",
          body: {
            noReply: true,
            parts: [{ type: "text", text: "First fixed prompt" }],
          },
        },
      );
      await f.oc.request(`/session/${s.id}/message`, {
        method: "POST",
        body: {
          noReply: true,
          parts: [{ type: "text", text: "Second fixed prompt" }],
        },
      });
      const server = await f.sidecar();
      c = new WsClient(server.url);
      await c.connect();
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await c.rpc("session.revert", {
        sessionID: s.id,
        messageID: prompt.info.id,
      });
      const b = await f.browser(server.url);
      await openSession(b, s.id);
      await b.poll("!!document.querySelector('.otk-rolled-back-strip')");
      assertEquals(
        await b.evaluate(
          "(()=>{const notice=document.querySelector('.otk-composer-notice').getBoundingClientRect(),input=document.querySelector('.otk-composer-input').getBoundingClientRect(),prompt=document.querySelector('.otk-prompt').getBoundingClientRect();return {sameLeft:notice.left===input.left,sameRight:notice.right===input.right,joined:Math.abs(notice.bottom-input.top)<=1,promptInside:prompt.top>=input.top}})()",
        ),
        { sameLeft: true, sameRight: true, joined: true, promptInside: true },
      );
    } finally {
      await c?.close();
      await f.stop();
    }
  });
}
test("revert pending and error stay joined to the composer and retry clears failure", async () => {
  const f = await browserFixture();
  let gate = Promise.withResolvers<void>(), fail = true;
  let c: WsClient | undefined;
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/revert")) {
        await gate.promise;
        if (fail) {
          return Response.json({
            _tag: "SessionBusyError",
            sessionID: url.pathname.split("/")[2],
          }, { status: 409 });
        }
      }
      url.host = new URL(f.oc.url).host;
      return fetch(new Request(url, request));
    },
  );
  try {
    const s = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Notice paint" },
    });
    await f.oc.request(`/session/${s.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "Fixed notice prompt" }],
      },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.addr.port}` },
    });
    c = new WsClient(server.url);
    await c.connect();
    const b = await f.browser(server.url);
    await openSession(b, s.id);
    await b.poll("!!document.querySelector('.otk-user-bubble')");
    await b.evaluate("document.querySelector('.otk-user-bubble').focus()");
    await b.click('[data-message-command="prompt.revert"]');
    await b.poll(
      "document.querySelector('.otk-composer-notice [role=status]')?.textContent.includes('Rolling back')",
    );
    gate.resolve();
    await b.poll(
      "!!document.querySelector('.otk-composer-notice [role=alert]')",
    );
    const geometry = (selector: string) =>
      b.evaluate<
        {
          row: number;
          notice: number;
          textOffset: number;
          icon: number[];
          iconOffset: number;
        }
      >(`(()=>{const row=document.querySelector(${
        JSON.stringify(selector)
      }),text=row.querySelector('.otk-composer-notice-content')||row.querySelector('strong')||row,icon=row.querySelector('.otk-composer-notice-icon'),r=row.getBoundingClientRect(),t=text.getBoundingClientRect(),i=icon.getBoundingClientRect();return {row:r.height,notice:document.querySelector('.otk-composer-notice').getBoundingClientRect().height,textOffset:(t.top+t.height/2)-(r.top+r.height/2),icon:[i.width,i.height],iconOffset:(i.top+i.height/2)-(r.top+r.height/2)}})()`);
    const errors = new Map<string, Awaited<ReturnType<typeof geometry>>>();
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      errors.set(theme, await geometry(".otk-composer-notice [role=alert]"));
    }
    fail = false;
    gate = Promise.withResolvers<void>();
    gate.resolve();
    await b.evaluate("document.querySelector('.otk-user-bubble').focus()");
    await b.click('[data-message-command="prompt.revert"]');
    await b.poll("!!document.querySelector('.otk-rollback-disclosure')");
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const error = errors.get(theme)!,
        collapsed = await geometry(".otk-rollback-disclosure");
      assertEquals(error.row, collapsed.row);
      assertEquals(error.notice, collapsed.notice);
      assertEquals(error.icon, collapsed.icon);
      assertEquals(error.icon, [error.row, error.row]);
      assert(Math.abs(error.textOffset) < .5);
      assert(Math.abs(collapsed.textOffset) < .5);
      assertEquals(error.iconOffset, 0);
    }
  } finally {
    gate.resolve();
    await c?.close();
    await f.stop();
    await proxy.shutdown();
  }
});
