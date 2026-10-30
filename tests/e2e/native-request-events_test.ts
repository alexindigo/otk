// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { resources, test } from "../support/resources.ts";
import { serve } from "../support/http.ts";
import { WsClient } from "../support/ws-client.ts";

test("a completed native shell with held HTTP settlement stays pending across reconnect and preserves the next draft", async () => {
  const f = await browserFixture({ bash: "deny" });
  const session = await f.oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Reattached native command" },
  });
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  let effects = 0;
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      const response = await fetch(
        new Request(f.oc.url + url.pathname + url.search, request),
      );
      if (
        request.method !== "POST" || !url.pathname.endsWith("/shell")
      ) return response;
      effects++;
      const bytes = await response.arrayBuffer();
      entered.resolve();
      await held.promise;
      return new Response(bytes, {
        status: response.status,
        headers: response.headers,
      });
    },
  );
  resources().defer("held shell receipt", () => proxy.shutdown());
  let client: WsClient | undefined;
  try {
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.addr.port}` },
    });
    const browser = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source:
        `window.requestSockets=[];window.requestFrames=[];window.WebSocket=class extends WebSocket{constructor(...args){super(...args);window.requestSockets.push(this)}send(value){window.requestFrames.push(JSON.parse(value));return super.send(value)}}`,
    });
    await browser.goto(server.url);
    await openSession(browser, session.id);
    await browser.click("textarea[name=prompt]");
    await browser.key("!");
    await browser.type("textarea[name=prompt]", "printf request-native-once");
    await browser.key("Enter");
    await entered.promise;
    await browser.poll(
      "document.querySelector('[data-tool=bash]')?.textContent.includes('request-native-once') && !!document.querySelector('.otk-operation-feedback.is-pending')",
    );
    await browser.fill(
      "textarea[name=prompt]",
      "New draft survives the old receipt",
    );
    await browser.evaluate("window.requestSockets.at(-1).close()");
    await browser.poll(
      "window.requestFrames.some(frame=>frame.t==='request.resume')",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      assertEquals(
        await browser.evaluate(
          "document.querySelector('textarea[name=prompt]').value",
        ),
        "New draft survives the old receipt",
      );
      assertEquals(
        await browser.evaluate(
          "document.querySelectorAll('.otk-composer-dock [role=alert],.otk-prompt button[type=submit]').length",
        ),
        0,
      );
      await browser.screenshot(
        join(f.oc.root, `native-request-pending-${theme}.png`),
      );
    }
    assertEquals(effects, 1);
    held.resolve();
    await browser.poll(
      "!document.querySelector('.otk-operation-feedback.is-pending') && !!document.querySelector('.otk-prompt button[type=submit]')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "New draft survives the old receipt",
    );
    assertEquals(effects, 1);
    await Deno.writeTextFile(
      join(f.oc.root, "native-request-proof.json"),
      JSON.stringify(
        {
          effects,
          sessionID: session.id,
          draft: "New draft survives the old receipt",
        },
        null,
        2,
      ),
    );
  } finally {
    held.resolve();
    await client?.close();
    await f.stop();
    await proxy.shutdown();
  }
});
