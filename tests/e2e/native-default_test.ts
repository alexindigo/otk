// SPDX-License-Identifier: LGPL-3.0-only
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { resources, test } from "../support/resources.ts";
import { serve } from "../support/http.ts";
import { WsClient } from "../support/ws-client.ts";

test("an unreported native default stays honest in the footer and omitted on send while native applies its model", async () => {
  const f = await browserFixture();
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url),
        response = await fetch(
          new Request(f.oc.url + url.pathname + url.search, request),
        );
      if (
        request.method !== "GET" || url.pathname !== "/config"
      ) return response;
      const config = await response.json();
      delete config.model;
      return Response.json(config);
    },
  );
  resources().defer(
    "native-default visual reporting proxy",
    () => proxy.shutdown(),
  );
  let client: WsClient | undefined;
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Unreported default scene" },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.addr.port}` },
    });
    client = new WsClient(server.url);
    await client.connect();
    const b = await f.browser(server.url);
    await openSession(b, session.id);
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(
        `document.documentElement.dataset.otkTheme==='${theme}' && document.querySelector('.otk-model-picker > button')?.textContent.includes('Backend default (not reported)')`,
      );
    }
  } finally {
    await client?.close();
    await f.stop();
  }
});
