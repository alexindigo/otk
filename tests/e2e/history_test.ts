// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";
import type { HistoryEntry } from "@otk/protocol";
Deno.test("P6 history merges connected sidecars by time, recalls shell mode and protects edited recalled drafts", async () => {
  const a = await browserFixture(), b = await browserFixture();
  try {
    const first = await a.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "History local" },
      }),
      blank = await a.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Blank" },
      }),
      other = await b.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "History remote" },
      });
    await a.oc.request(`/session/${first.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "local older prompt" }],
      },
    });
    await b.oc.request(`/session/${other.id}/shell`, {
      method: "POST",
      body: { agent: "build", command: "echo remote-history-shell" },
    });
    await b.oc.request(`/session/${other.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "remote newest prompt" }],
      },
    });
    const local = await a.sidecar(),
      remote = await b.sidecar({ server: { origins: [local.url] } }),
      browser = await a.browser(local.url);
    await browser.poll(
      "document.querySelector('.otk-server-status[data-connection=local]')?.title.includes(': connected;')",
    );
    await browser.click(".otk-settings-entry");
    await browser.poll("!!document.querySelector('input[name=url]')");
    await browser.fill("input[name=url]", remote.url);
    await browser.fill("input[name=label]", "History remote sidecar");
    await browser.click(
      ".otk-settings .otk-settings-content > .otk-form button[type=submit]",
    );
    await browser.poll(
      "document.querySelectorAll('.otk-sidecar-card [data-connection]').length===2 && [...document.querySelectorAll('.otk-sidecar-card [data-connection]')].every(el=>el.textContent==='connected')",
    );
    await browser.click(".otk-settings .otk-view-header button");
    await openSession(browser, first.id);
    await browser.click("textarea[name=prompt]");
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='remote newest prompt'",
    );
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='echo remote-history-shell' && document.querySelector('.otk-prompt > label').textContent==='Shell'",
    );
    await browser.screenshot(join(a.oc.root, "p6-shell-history.png"));
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='local older prompt' && document.querySelector('.otk-prompt > label').textContent==='Prompt'",
    );
    await browser.type("textarea[name=prompt]", "edited ");
    const edited = await browser.evaluate<string>(
      "document.querySelector('textarea[name=prompt]').value",
    );
    await browser.evaluate(
      "document.querySelector('textarea[name=prompt]').setSelectionRange(0,0)",
    );
    await browser.key("ArrowUp");
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      edited,
    );
    await browser.fill("textarea[name=prompt]", "");
    await openSession(browser, blank.id);
    await browser.click("textarea[name=prompt]");
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='remote newest prompt'",
    );
    await browser.evaluate(
      "(()=>{const el=document.querySelector('textarea[name=prompt]');el.setSelectionRange(el.value.length,el.value.length)})()",
    );
    await browser.key("ArrowDown");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value===''",
    );
  } finally {
    await a.stop();
    await b.stop();
  }
});
Deno.test("recalled image metadata resolves exact bytes only on send through its originating sidecar", async () => {
  const a = await browserFixture(), b = await browserFixture();
  let client: WsClient | undefined;
  const bytes =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  try {
    const blank = await a.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Recall image here" },
    });
    const source = await b.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Remote image source" },
    });
    await b.oc.request(`/session/${source.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "inspect [Image 1]" }, {
          type: "file",
          filename: "pixel.png",
          mime: "image/png",
          url: `data:image/png;base64,${bytes}`,
        }],
      },
    });
    const local = await a.sidecar(),
      remote = await b.sidecar({ server: { origins: [local.url] } }),
      browser = await a.browser(local.url);
    client = new WsClient(remote.url);
    await client.connect();
    const metadata = await client.rpc<HistoryEntry[]>("history.list", {});
    assertEquals(JSON.stringify(metadata).includes("dataBase64"), false);
    assertEquals(JSON.stringify(metadata).includes(bytes), false);
    await browser.poll(
      "document.querySelector('.otk-server-status[data-connection=local]')?.title.includes(': connected;')",
    );
    await browser.click(".otk-settings-entry");
    await browser.fill("input[name=url]", remote.url);
    await browser.click(
      ".otk-settings-content > .otk-form button[type=submit]",
    );
    await browser.poll(
      "document.querySelectorAll('.otk-sidecar-card [data-connection]').length===2 && [...document.querySelectorAll('.otk-sidecar-card [data-connection]')].every(el=>el.textContent==='connected')",
    );
    await browser.click(".otk-settings .otk-view-header button");
    await openSession(browser, blank.id);
    await browser.click("textarea[name=prompt]");
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelectorAll('.otk-prompt-chip').length===1 && document.querySelector('.otk-prompt-chip button').textContent==='[Image 1]' && document.querySelector('.otk-prompt-chip button').title==='pixel.png'",
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) =>
        frame.method === "history.attachment"
      ).length,
      0,
    );
    await browser.key("Enter");
    const rows = await waitFor(
      () =>
        a.oc.request<
          { parts: { type: string; filename?: string; url?: string }[] }[]
        >(`/session/${blank.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.parts.some((part) =>
            part.type === "file" && part.filename === "pixel.png"
          )
        ),
    );
    assertEquals(
      rows.flatMap((row) => row.parts).find((part) =>
        part.type === "file" && part.filename === "pixel.png"
      )!.url,
      `data:image/png;base64,${bytes}`,
    );
    const requests = sentFrames(browser).filter(({ frame }) =>
      frame.method === "history.attachment"
    );
    assertEquals(requests.length, 1);
    assertEquals(
      requests[0].frame.params && typeof requests[0].frame.params,
      "object",
    );
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='' && !document.querySelector('.otk-prompt-chip')",
    );
  } finally {
    await client?.close();
    await a.stop();
    await b.stop();
  }
});
Deno.test("history keeps valid local prompts when a connected sibling transport fails during recall", async () => {
  const f = await browserFixture();
  try {
    const source = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "History source" },
    });
    const blank = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Recall here" },
    });
    await f.oc.request(`/session/${source.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "valid local history" }],
      },
    });
    const local = await f.sidecar(),
      remote = await f.sidecar({ server: { origins: [local.url] } }),
      browser = await f.browser(local.url);
    await browser.poll(
      "document.querySelector('.otk-server-status[data-connection=local]')?.title.includes(': connected;')",
    );
    await browser.click(".otk-settings-entry");
    await browser.fill("input[name=url]", remote.url);
    await browser.click(
      ".otk-settings-content > .otk-form button[type=submit]",
    );
    await browser.poll(
      "document.querySelectorAll('.otk-sidecar-card [data-connection]').length===2 && [...document.querySelectorAll('.otk-sidecar-card [data-connection]')].every(el=>el.textContent==='connected')",
    );
    await browser.click(".otk-settings .otk-view-header button");
    await openSession(browser, blank.id);
    await browser.evaluate(
      `(()=>{const original=WebSocket.prototype.send;WebSocket.prototype.send=function(data){const frame=JSON.parse(data);if(frame.method==='history.list'&&this.url.startsWith(${
        JSON.stringify(remote.url.replace("http:", "ws:"))
      })){this.close();return;}return original.call(this,data);}})()`,
    );
    await browser.click("textarea[name=prompt]");
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='valid local history'",
    );
  } finally {
    await f.stop();
  }
});
Deno.test("recalled prompt caret is ready for the next native history key before a paint callback", async () => {
  const f = await browserFixture();
  try {
    const source = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Caret history source" },
    });
    const blank = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Caret recall" },
    });
    for (const text of ["older caret prompt", "newer caret prompt"]) {
      await f.oc.request(`/session/${source.id}/message`, {
        method: "POST",
        body: { noReply: true, parts: [{ type: "text", text }] },
      });
    }
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, blank.id);
    // Prepare pointer/focus before holding paint for the history-key proof.
    await browser.click("textarea[name=prompt]");
    await browser.poll(
      "document.activeElement===document.querySelector('textarea[name=prompt]')",
    );
    await browser.evaluate(
      "(()=>{globalThis.savedHistoryRaf=requestAnimationFrame;globalThis.historyRafCallbacks=[];globalThis.requestAnimationFrame=callback=>{globalThis.historyRafCallbacks.push(callback);return globalThis.historyRafCallbacks.length}})()",
    );
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='newer caret prompt'",
    );
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='older caret prompt'",
    );
    await browser.evaluate(
      "globalThis.requestAnimationFrame=globalThis.savedHistoryRaf",
    );
  } finally {
    await f.stop();
  }
});
