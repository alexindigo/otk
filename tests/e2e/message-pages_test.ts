// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { MessagePage } from "@otk/protocol";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForCollapsedPanels,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`native newest10 keeps off-page composer/Undo context, pages, streams and restores after reload (${theme})`, async () => {
    const f = await browserFixture({ bash: "allow" });
    let client: WsClient | undefined;
    try {
      const session = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Cursor continuity review" },
      });
      for (let i = 0; i < 12; i++) {
        await f.oc.request(`/session/${session.id}/message`, {
          method: "POST",
          body: {
            noReply: true,
            parts: [{ type: "text", text: `Earlier prompt ${i}` }],
          },
        });
      }
      for (let i = 0; i < 11; i++) {
        f.fake.queue({
          tool: {
            name: "bash",
            input: {
              command: `printf 'step-${i}'`,
              description: `Read step ${i}`,
            },
          },
        });
      }
      f.fake.queue({ chunks: ["The cursor keeps every earlier step."] });
      await f.oc.request(`/session/${session.id}/message`, {
        method: "POST",
        body: {
          agent: "build",
          model: { providerID: "fake", modelID: "scripted" },
          parts: [{ type: "text", text: "Boundary prompt outside newest ten" }],
        },
      });
      const server = await f.sidecar();
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await client.rpc("prefs.set", { key: "animationsOff", value: true });
      const b = await f.browser(server.url);
      await b.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await openSession(b, session.id);
      await waitForReply(b, session.id, "The cursor keeps every earlier step.");
      const page = await client.rpc<MessagePage>("session.messages", {
        sessionID: session.id,
      });
      assertEquals(page.items.length, 10);
      assert(page.items.every((message) => message.role === "assistant"));
      assert(
        page.prompt &&
          !page.items.some((message) => message.id === page.prompt!.id),
      );
      assertEquals(page.prompt.model, { provider: "fake", model: "scripted" });
      assertEquals(page.prompt.agent, "build");
      assert(page.older);
      await b.poll(
        "document.querySelector('.otk-composer-agent')?.textContent==='Build' && document.querySelector('.otk-composer-model-name')?.textContent.includes('scripted')",
      );
      const initial = sentFrames(b).filter(({ frame }) =>
        frame.method === "session.messages"
      );
      assert(initial.length >= 1);
      assert(
        initial.every(({ frame }) =>
          !("limit" in (frame.params as Record<string, unknown>))
        ),
      );
      const shots = Deno.env.get("OTK_MESSAGES_SHOTS");
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        await b.screenshot(join(shots, `${theme}-newest10.png`));
      }
      await b.fill("textarea[name=prompt]", "/undo");
      await b.key("Enter");
      await b.poll(
        "document.querySelector('textarea[name=prompt]')?.value==='Boundary prompt outside newest ten' && document.querySelector('.otk-rolled-back-strip strong')?.textContent==='1 prompt rolled back'",
      );
      await b.click(".otk-rollback-disclosure");
      await b.click(".otk-rollback-footer button");
      await b.poll(
        "!document.querySelector('.otk-rolled-back-strip') && document.querySelector('.otk-message-flow')?.textContent.includes('The cursor keeps every earlier step.')",
      );
      await b.reload();
      await b.poll(
        "document.querySelector('.otk-message-flow')?.textContent.includes('The cursor keeps every earlier step.') && !!document.querySelector('textarea[name=prompt]')",
      );
      await b.evaluate("document.querySelector('.otk-messages').scrollTop=0");
      // Automatic reserve/top-edge paging may retire Load older before a click.
      // Observe the requested earlier source, rather than wait for a stale control.
      await b.poll(
        "document.querySelector('.otk-message-flow')?.textContent.includes('Boundary prompt outside newest ten')",
      );
      assert(
        sentFrames(b).some(({ frame }) =>
          frame.method === "session.messages" &&
          !!(frame.params as { before?: string }).before
        ),
        "earlier content came through the native cursor owner",
      );
      f.fake.queue({
        chunks: ["A fresh ", "stream remains ", "aligned."],
        delay: 100,
      });
      await b.fill("textarea[name=prompt]", "Continue with a short reply");
      await b.key("Enter");
      await waitForReply(b, session.id, "A fresh stream remains aligned.");
      await b.reload();
      await b.poll(
        "document.querySelector('.otk-message-flow')?.textContent.includes('A fresh stream remains aligned.')",
      );
      await b.send("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      });
      if (shots) {
        await b.screenshot(join(shots, `${theme}-reloaded-stream-narrow.png`));
      }
      await b.click('[aria-label="Collapse projects"]');
      await b.click('[aria-label="Collapse right panel"]');
      await waitForCollapsedPanels(b);
      const geometry = await b.evaluate<{ left: number; right: number }>(
        "(()=>{const a=document.querySelector('.otk-message-flow').getBoundingClientRect(),b=document.querySelector('.otk-composer-input').getBoundingClientRect();return {left:Math.abs(a.left-b.left),right:Math.abs(a.right-b.right)}})()",
      );
      assert(
        geometry.left <= 1 && geometry.right <= 1,
        JSON.stringify(geometry),
      );
      if (shots) {
        await b.screenshot(
          join(shots, `${theme}-reloaded-stream-collapsed.png`),
        );
      }
      assertEquals(b.errors, []);
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}
