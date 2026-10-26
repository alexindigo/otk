// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { WsClient } from "../support/ws-client.ts";
import type { Cdp } from "../support/cdp.ts";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";

async function palette(b: Cdp, command: string) {
  await b.key("k", 2);
  await b.poll(`!!document.querySelector('[data-command="${command}"]')`);
  await b.click(`[data-command="${command}"]`);
  await b.poll("!document.querySelector('dialog[aria-label=Commands][open]')");
}
async function capture(b: Cdp, name: string) {
  const destination = Deno.env.get("OTK_SESSION_ACTION_SCREENSHOTS");
  if (destination) await b.screenshot(join(destination, `${name}.png`));
}
for (const theme of ["otk-dark", "otk-light"]) {
  test(`undo/redo aliases recall prompts, palette protects edited drafts and busy Undo interrupts (${theme})`, async () => {
    const f = await browserFixture();
    let client: WsClient | undefined;
    const mutations: string[] = [];
    let restoreWait: Promise<void> | undefined,
      releaseRestore: (() => void) | undefined;
    const proxy = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        const url = new URL(request.url);
        if (
          request.method === "POST" &&
          /\/(abort|revert|unrevert)$/.test(url.pathname)
        ) mutations.push(url.pathname.split("/").at(-1)!);
        if (url.pathname.endsWith("/unrevert")) await restoreWait;
        url.host = new URL(f.oc.url).host;
        return fetch(new Request(url, request));
      },
    );
    try {
      const s = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Undo review" },
      });
      const server = await f.sidecar({
        harness: { url: `http://127.0.0.1:${proxy.addr.port}` },
      });
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      const b = await f.browser(server.url);
      await openSession(b, s.id);
      for (const text of ["First prompt", "Second prompt"]) {
        f.fake.queue({ chunks: [`Reply to ${text}.`] });
        await b.fill("textarea[name=prompt]", text);
        await b.key("Enter");
        await waitForReply(b, s.id, `Reply to ${text}.`);
      }
      await b.fill("textarea[name=prompt]", "/undo");
      await b.key("Enter");
      await b.poll(
        "document.querySelector('textarea[name=prompt]')?.value==='Second prompt' && document.querySelector('.otk-rolled-back-strip strong')?.textContent==='1 prompt rolled back'",
      );
      await capture(b, `${theme}-undo-recalled`);
      await b.key("k", 2);
      await b.poll(
        "!!document.querySelector('[data-command=\"session.undo\"]') && !!document.querySelector('[data-command=\"session.redo\"]')",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelectorAll('.otk-palette-list button:disabled').length",
        ),
        0,
      );
      await b.key("Escape");
      await b.fill("textarea[name=prompt]", "/undo");
      await b.key("Enter");
      await b.poll(
        "document.querySelector('textarea[name=prompt]')?.value==='First prompt' && document.querySelector('.otk-rolled-back-strip strong')?.textContent==='2 prompts rolled back'",
      );
      const restoring = Promise.withResolvers<void>();
      restoreWait = restoring.promise;
      releaseRestore = () => restoring.resolve();
      await b.fill("textarea[name=prompt]", "/redo");
      await b.key("Enter");
      await b.poll(
        "document.querySelector('.otk-rollback-status')?.textContent==='Restoring…'",
      );
      await capture(b, `${theme}-redo-pending`);
      restoring.resolve();
      restoreWait = undefined;
      await b.poll(
        "document.querySelector('textarea[name=prompt]')?.value==='' && !document.querySelector('.otk-rolled-back-strip') && document.querySelectorAll('[data-role=user]').length===2",
      );
      await capture(b, `${theme}-redo-restored`);
      await b.fill("textarea[name=prompt]", "Keep this edited draft");
      await palette(b, "session.undo");
      await b.poll(
        "document.querySelector('.otk-rolled-back-strip strong')?.textContent==='1 prompt rolled back'",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('textarea[name=prompt]').value",
        ),
        "Keep this edited draft",
      );
      await palette(b, "session.redo");
      await b.poll("!document.querySelector('.otk-rolled-back-strip')");
      assertEquals(
        await b.evaluate(
          "document.querySelector('textarea[name=prompt]').value",
        ),
        "Keep this edited draft",
      );
      f.fake.queue({ chunks: Array(30).fill("Still working. "), delay: 1000 });
      await b.fill("textarea[name=prompt]", "Interrupt this prompt");
      await b.key("Enter");
      await b.poll(
        `document.querySelector('[data-session="${s.id}"]').dataset.status==='busy'`,
      );
      const before = mutations.length;
      await palette(b, "session.undo");
      await b.poll(
        "document.querySelector('.otk-rolled-back-strip strong')?.textContent==='1 prompt rolled back' && document.querySelector('textarea[name=prompt]').value==='Interrupt this prompt'",
      );
      assertEquals(mutations.slice(before), ["abort", "revert"]);
      await palette(b, "session.redo");
      await b.poll(
        "!document.querySelector('.otk-rolled-back-strip') && document.querySelector('textarea[name=prompt]').value===''",
      );
      assertEquals(
        b.events.filter((e) => e.method === "Page.javascriptDialogOpening")
          .length,
        0,
      );
      assertEquals(b.errors, []);
    } finally {
      releaseRestore?.();
      await client?.close();
      await f.stop();
      await proxy.shutdown();
    }
  });
}
test("revert controls are absent while working and in read-only helpers", async () => {
  const f = await browserFixture();
  try {
    const root = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Root" },
    });
    const child = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Helper", parentID: root.id },
    });
    await f.oc.request(`/session/${child.id}/message`, {
      method: "POST",
      body: { noReply: true, parts: [{ type: "text", text: "Helper prompt" }] },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    await openSession(b, root.id);
    const held = f.fake.queueHeld({ chunks: ["Work in progress."] });
    await b.fill('textarea[name="prompt"]', "Keep working");
    await b.key("Enter");
    await b.poll(
      `document.querySelector('[data-session="${root.id}"]').dataset.status==='busy'`,
    );
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('[data-message-command=\"prompt.revert\"]')",
      ),
      false,
    );
    held.release();
    await waitForReply(b, root.id, "Work in progress.");
    await b.poll(
      "!!document.querySelector('[data-message-command=\"prompt.revert\"]')",
    );
    await openSession(b, child.id);
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('[data-message-command=\"prompt.revert\"]')",
      ),
      false,
    );
    await b.key("k", 2);
    await b.poll(
      "!!document.querySelector('dialog[aria-label=Commands][open]')",
    );
    assertEquals(
      await b.evaluate(
        "['session.undo','session.redo','session.compact'].some(id=>!!document.querySelector('[data-command=\"'+id+'\"]'))",
      ),
      false,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-palette-list button:disabled').length",
      ),
      0,
    );
    await b.key("Escape");
  } finally {
    await f.stop();
  }
});
