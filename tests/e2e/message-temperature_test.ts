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
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`native scope temperature retains drafts, releases cold subscriptions and preloads attention before navigation (${theme})`, async () => {
    const f = await browserFixture({ bash: "allow" });
    let client: WsClient | undefined;
    const held = f.fake.queueHeld({
      chunks: ["The cold scope is current again."],
    });
    try {
      const directoryB = join(f.oc.root, "second-project");
      await Deno.mkdir(directoryB);
      const a = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Temperature project A" },
      });
      const bSession = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        directory: directoryB,
        body: { title: "Temperature project B" },
      });
      for (
        const [session, directory] of [[a, f.oc.directory], [
          bSession,
          directoryB,
        ]] as const
      ) {
        for (let i = 0; i < 25; i++) {
          await f.oc.request(`/session/${session.id}/message`, {
            method: "POST",
            directory,
            body: {
              noReply: true,
              parts: [{
                type: "text",
                text: `${session.id === a.id ? "Alpha" : "Beta"} prompt ${i}`,
              }],
            },
          });
        }
      }
      const server = await f.sidecar({
        messages: { coolms: 2500, preloadms: 1500 },
      });
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await client.rpc("prefs.set", { key: "animationsOff", value: true });
      const browser = await f.browser(server.url);
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const pages = (id: string) =>
        sentFrames(browser).filter(({ frame }) =>
          frame.method === "session.messages" &&
          (frame.params as { sessionID?: string }).sessionID === id
        );
      const settledPages = (id: string) => {
        const requests = new Set(pages(id).map(({ frame }) => frame.id));
        return browser.events.filter((e) =>
          e.method === "Network.webSocketFrameReceived"
        ).map((e) =>
          JSON.parse((e.params.response as { payloadData: string }).payloadData)
        ).filter((frame) =>
          frame.t === "rpc.result" && frame.ok && requests.has(frame.id) &&
          (frame.result as MessagePage)?.items
        );
      };
      await openSession(browser, a.id);
      await waitFor(() => settledPages(a.id).length, (n) => n >= 2);
      await browser.fill("textarea[name=prompt]", "Unsent temperature draft");
      const reads = pages(a.id).length;
      await openSession(browser, bSession.id);
      await openSession(browser, a.id);
      await browser.poll(
        "document.querySelector('textarea[name=prompt]')?.value==='Unsent temperature draft'",
      );
      assertEquals(
        pages(a.id).length,
        reads,
        "warm return borrows the canonical body without another baseline",
      );
      await openSession(browser, bSession.id);
      await waitFor(
        () => sentFrames(browser),
        (frames) =>
          frames.some(({ frame }) =>
            frame.t === "unsubscribe" && frame.sessionID === a.id
          ),
      );
      assertEquals(
        await browser.evaluate(
          `document.querySelector('.otk-message-flow')?.textContent.includes('Alpha prompt')`,
        ),
        false,
      );
      const before = pages(a.id).length;
      await f.oc.request(`/session/${a.id}/prompt_async`, {
        method: "POST",
        body: { parts: [{ type: "text", text: "Wake the cold project" }] },
      });
      await waitFor(() => settledPages(a.id).length, (n) => n >= before + 2);
      const readyBeforeClick = performance.now();
      const preloaded = pages(a.id).length;
      assert(preloaded >= before + 2);
      assert(
        !await browser.evaluate(`location.hash.endsWith('/${a.id}')`),
        "preload never navigates",
      );
      const shots = Deno.env.get("OTK_MESSAGES_SHOTS");
      await browser.click('[aria-label="Collapse projects"]');
      await browser.click('[aria-label="Collapse right panel"]');
      await waitForCollapsedPanels(browser);
      await browser.poll(
        `document.querySelector('[data-project=${
          JSON.stringify(f.oc.directory)
        }]')?.dataset.rollup==='working'`,
      );
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        await browser.screenshot(join(shots, `${theme}-cold-attention.png`));
      }
      await browser.click('[aria-label="Expand projects"]');
      await openSession(browser, a.id);
      await browser.poll(
        "document.querySelector('textarea[name=prompt]')?.value==='Unsent temperature draft' && document.querySelector('.otk-message-flow')?.textContent.includes('Wake the cold project')",
      );
      assertEquals(
        pages(a.id).length,
        preloaded,
        "attention hydration is ready before click and not repeated",
      );
      assert(performance.now() >= readyBeforeClick);
      if (shots) {
        await browser.screenshot(join(shots, `${theme}-preloaded-draft.png`));
      }
      held.release();
      await browser.poll(
        "document.querySelector('.otk-message-flow')?.textContent.includes('The cold scope is current again.')",
      );
      assertEquals(browser.errors, []);
    } finally {
      held.release();
      await client?.close();
      await f.stop();
    }
  });
}
