// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture } from "../support/browser-fixture.ts";
import { resources, test } from "../support/resources.ts";
import { serve } from "../support/http.ts";

test("protocol 16 browser keeps a forty-second native page pending while events arrive and renders the final page once", async () => {
  const f = await browserFixture();
  const session = await f.oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Forty-second page" },
  });
  await f.oc.request(`/session/${session.id}/message`, {
    method: "POST",
    body: {
      noReply: true,
      parts: [{ type: "text", text: "Seed before the held native page" }],
    },
  });
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  let holding = true, pageReads = 0;
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        url.pathname === `/session/${session.nativeID}/message` && holding
      ) {
        pageReads++;
        entered.resolve();
        await held.promise;
      }
      return await fetch(
        new Request(f.oc.url + url.pathname + url.search, request),
      );
    },
  );
  resources().defer("native page delay proxy", () => proxy.shutdown());
  const observations: unknown[] = [];
  try {
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.addr.port}` },
    });
    const browser = await f.browser(server.url + `/#/local/${session.id}`);
    await entered.promise;
    const start = performance.now();
    const inspect = async () => {
      const state = await browser.evaluate<
        { loading: boolean; failed: string[]; protocol: boolean }
      >(`({
        loading:document.querySelector('.otk-messages')?.textContent.includes('Loading messages'),
        failed:[...document.querySelectorAll('[role="alert"],.otk-error')].map(el=>el.textContent).filter(text=>/timed out|timeout|operation was aborted|could not load/i.test(text)),
        protocol:!document.body.textContent.includes('protocol mismatch')
      })`);
      observations.push({ elapsed: performance.now() - start, ...state });
      assert(state.loading, JSON.stringify(state));
      assertEquals(state.failed, []);
      assert(state.protocol);
    };
    await new Promise((resolve) => setTimeout(resolve, 16000));
    await inspect();
    await f.oc.request(`/session/${session.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "Event arrived during the held page" }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 15000));
    await inspect();
    await new Promise((resolve) => setTimeout(resolve, 9000));
    holding = false;
    held.resolve();
    await browser.poll(
      "document.querySelector('.otk-messages')?.textContent.includes('Event arrived during the held page')",
      15000,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-messages [data-role=\"user\"]').length",
      ),
      2,
    );
    assertEquals(
      pageReads,
      1,
      "The slow native page must finish in one configured 60-second read attempt",
    );
    assertEquals(browser.errors, []);
    await Deno.writeTextFile(
      join(f.oc.root, "request-activation-proof.json"),
      JSON.stringify(
        {
          observations,
          pageReads,
          elapsed: performance.now() - start,
          sessionID: session.id,
        },
        null,
        2,
      ),
    );
    await browser.screenshot(join(f.oc.root, "request-activation-final.png"));
  } finally {
    holding = false;
    held.resolve();
    await f.stop();
    await proxy.shutdown();
  }
});
