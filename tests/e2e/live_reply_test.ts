// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";
import type { Message } from "@otk/protocol";
test("reload, switching and an initially unwatched reply retain all current text and its future suffix", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const a = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Live reply A" },
    });
    const b = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Other session" },
    });
    const c = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Initially unwatched" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await openSession(browser, a.id);
    const chunks = Array.from(
      { length: 32 },
      (_, i) => `chunk${String(i).padStart(2, "0")} `,
    );
    const reply = f.fake.queueHeld({ chunks, delay: 700 });
    await browser.type("textarea[name=prompt]", "Keep this live reply");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-role=assistant] .otk-text')?.textContent.includes('chunk03')",
    );
    const prefix = await browser.evaluate<string>(
      "document.querySelector('[data-role=assistant] .otk-text').textContent.trim()",
    );
    await browser.reload();
    await browser.poll(
      `document.querySelector('[data-role=assistant] .otk-text')?.textContent.startsWith(${
        JSON.stringify(prefix)
      }) && document.querySelector('[data-session="${a.id}"]').dataset.status==='busy'`,
    );
    await openSession(browser, b.id);
    const unseen = await waitFor(
      () =>
        client!.rpc<Message[]>("session.messages", {
          sessionID: a.id,
          limit: 100,
        }),
      (rows) => JSON.stringify(rows).includes("chunk08"),
    );
    assertEquals(JSON.stringify(unseen).includes(prefix), true);
    await openSession(browser, a.id);
    await browser.poll(
      `document.querySelector('[data-role=assistant] .otk-text')?.textContent.includes('chunk08') && document.querySelector('[data-role=assistant] .otk-text').textContent.startsWith(${
        JSON.stringify(prefix)
      })`,
    );
    reply.release();
    await browser.poll(
      `document.querySelector('[data-session="${a.id}"]').dataset.status==='idle' && document.querySelector('[data-role=assistant] .otk-text')?.textContent.trim()===${
        JSON.stringify(chunks.join("").trim())
      }`,
      60000,
    );
    await openSession(browser, b.id);
    const unwatched = Array.from(
      { length: 12 },
      (_, i) => `unwatched${String(i).padStart(2, "0")} `,
    );
    f.fake.queue({ chunks: unwatched, delay: 700 });
    await f.oc.request(`/session/${c.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Start without a viewer" }] },
    });
    await waitFor(
      () =>
        client!.rpc<Message[]>("session.messages", {
          sessionID: c.id,
          limit: 100,
        }),
      (rows) => JSON.stringify(rows).includes("unwatched03"),
    );
    await openSession(browser, c.id);
    await browser.poll(
      "document.querySelector('[data-role=assistant] .otk-text')?.textContent.includes('unwatched03')",
    );
    await browser.poll(
      `document.querySelector('[data-session="${c.id}"]').dataset.status==='idle' && document.querySelector('[data-role=assistant] .otk-text')?.textContent.trim()===${
        JSON.stringify(unwatched.join("").trim())
      }`,
      60000,
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});
