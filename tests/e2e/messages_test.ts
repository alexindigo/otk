// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { runTool } from "../support/rendering.ts";
import { WsClient } from "../support/ws-client.ts";
test("R8 revert RPC restores files, hides reverted turns and persists a counted file banner on reload", async () => {
  const f = await browserFixture({ edit: "allow", read: "allow" }, {
    prepare: async (oc) => {
      await Deno.writeTextFile(join(oc.directory, "revert.txt"), "before\n");
    },
  });
  let client: WsClient | undefined;
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Revert rendering" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, s.id);
    await runTool(f, browser, s.id, {
      name: "edit",
      input: {
        filePath: join(f.oc.directory, "revert.txt"),
        oldString: "before",
        newString: "after",
      },
    });
    assertEquals(
      await Deno.readTextFile(join(f.oc.directory, "revert.txt")),
      "after\n",
    );
    const raw = await f.oc.request<{ info: { id: string; role: string } }[]>(
        `/session/${s.id}/message`,
      ),
      user = raw.find((m) => m.info.role === "user")!.info.id;
    client = new WsClient(server.url);
    await client.connect();
    client.send({ t: "subscribe", sessionID: s.id });
    await client.rpc("session.revert", { sessionID: s.id, messageID: user });
    await client.wait((frame) =>
      frame.t === "content" && frame.event.op === "session.revert" &&
      frame.event.messageCount === 1
    );
    await browser.poll(
      "document.querySelector('.otk-revert-banner')?.textContent.includes('1 message reverted') && document.querySelector('.otk-revert-banner')?.textContent.includes('revert.txt') && document.querySelectorAll('[data-message]').length===0",
    );
    assertEquals(
      await Deno.readTextFile(join(f.oc.directory, "revert.txt")),
      "before\n",
    );
    await browser.reload();
    await browser.poll(
      "document.querySelector('.otk-revert-banner')?.textContent.includes('1 message reverted') && document.querySelectorAll('[data-message]').length===0",
    );
    await browser.screenshot(join(f.oc.root, "r8-revert.png"));
    const session = await f.oc.request(`/session/${s.id}`);
    await Deno.writeTextFile(
      join(f.oc.root, "recorded-revert.json"),
      JSON.stringify({ session, messages: raw }, null, 2),
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});
test("real harness history renders file/agent chips and compaction divider", async () => {
  const f = await browserFixture();
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "History details" },
    });
    const m = await f.oc.request<{ info: { id: string } }>(
      `/session/${s.id}/message`,
      {
        method: "POST",
        body: {
          noReply: true,
          parts: [{ type: "text", text: "Historical parts" }],
        },
      },
    );
    for (
      const value of [
        {
          type: "file",
          mime: "text/plain",
          filename: "fixture.txt",
          url: "file:///fixture.txt",
        },
        { type: "agent", name: "general" },
        { type: "compaction", auto: false },
      ]
    ) {
      const id = "prt_" + crypto.randomUUID().replaceAll("-", "");
      await f.oc.request(`/session/${s.id}/message/${m.info.id}/part/${id}`, {
        method: "PATCH",
        body: { id, sessionID: s.id, messageID: m.info.id, ...value },
      });
    }
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, s.id);
    await browser.poll(
      "document.querySelector('.otk-messages').textContent.includes('File: fixture.txt') && document.querySelector('.otk-messages').textContent.includes('Agent: general') && !!document.querySelector('.otk-compaction-divider')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-compaction-divider').closest('.otk-user-bubble')===null",
      ),
      true,
      "Transcript markers must not inherit a prompt bubble in mixed messages",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-user-bubble').textContent.includes('Historical parts')",
      ),
      true,
    );
    await browser.screenshot(join(f.oc.root, "message-chips-compaction.png"));
  } finally {
    await f.stop();
  }
});
test("message details show configured agent colour, queued-to-answered transition and no step scaffolds", async () => {
  const f = await browserFixture(undefined, {
    config: { agent: { build: { color: "#6bacff" } } },
  });
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Message details" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, s.id);
    const reply = f.fake.queueHeld({
      chunks: Array(20).fill("First reply continues. "),
      delay: 100,
    });
    f.fake.queue({ chunks: ["Queued prompt answered."] });
    await browser.type("textarea[name=prompt]", "First prompt");
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${s.id}"]').dataset.status==='busy' && !!document.querySelector('[data-role=assistant] .otk-text')`,
    );
    await browser.type("textarea[name=prompt]", "Queued prompt");
    await browser.key("Enter");
    await browser.poll("!!document.querySelector('.otk-queued')");
    // The visual system replaces the heavy user-message border with a subtle
    // surface. The quiet metadata reveals the configured agent colour on hover.
    await browser.click(".otk-message-agent");
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.querySelector('.otk-message-agent')).color",
      ),
      "rgb(107, 172, 255)",
    );
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.querySelector('[data-role=user]')).borderLeftWidth",
      ),
      "0px",
    );
    await browser.screenshot(join(f.oc.root, "message-queued.png"));
    reply.release();
    await browser.poll(
      `document.querySelector('[data-session="${s.id}"]').dataset.status==='idle' && document.querySelector('.otk-messages').textContent.includes('Queued prompt answered.') && !document.querySelector('.otk-queued')`,
      60000,
    );
    const footers = await browser.evaluate<string[]>(
      "[...document.querySelectorAll('.otk-message-footer')].map(el=>el.textContent)",
    );
    assert(
      footers.every((footer) => footer.includes("build") && /\ds/.test(footer)),
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('.otk-messages p')].some(el=>el.textContent==='step'||el.textContent==='unknown')",
      ),
      false,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-message-footer .otk-copy-message svg').length",
      ),
      footers.length,
      "Plain metadata has a copy affordance instead of a role glyph",
    );
    await browser.screenshot(join(f.oc.root, "message-answered.png"));
  } finally {
    await f.stop();
  }
});
