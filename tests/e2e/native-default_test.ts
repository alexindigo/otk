// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { resources, test } from "../support/resources.ts";
import { serve } from "../support/http.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";

test("an unreported native default stays honest in the footer and omitted on send while native applies its model", async () => {
  const f = await browserFixture();
  const bodies: Record<string, unknown>[] = [];
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (
        request.method === "POST" && url.pathname.endsWith("/prompt_async")
      ) bodies.push(await request.clone().json());
      const response = await fetch(
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
  resources().defer("native-default reporting proxy", () => proxy.shutdown());
  let client: WsClient | undefined;
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Unreported backend default" },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.addr.port}` },
    });
    client = new WsClient(server.url);
    await client.connect();
    const b = await f.browser(server.url);
    await openSession(b, session.id);
    await b.poll(
      "document.querySelector('.otk-model-picker > button')?.textContent.includes('Backend default (not reported)')",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const shots = Deno.env.get("OTK_METADATA_SHOTS");
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        await b.evaluate(
          "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
        );
        await b.screenshot(join(shots, `${theme}-native-default.png`));
      }
    }
    f.fake.queue({ chunks: ["Native default applied."] });
    await b.fill("textarea[name=prompt]", "Use the backend default");
    await b.key("Enter");
    await waitForReply(b, session.id, "Native default applied.");
    const frame = sentFrames(b).find(({ frame }) =>
      frame.method === "session.prompt"
    )!.frame;
    assert(!("model" in (frame.params as Record<string, unknown>)));
    assertEquals(bodies.length, 1);
    assert(!("model" in bodies[0]));
    const rows = await waitFor(
      () =>
        f.oc.request<
          {
            info: {
              role: string;
              model?: { providerID: string; modelID: string };
            };
          }[]
        >(`/session/${session.id}/message`),
      (rows) => rows.some((row) => row.info.role === "user"),
    );
    const applied = rows.find((row) => row.info.role === "user")!.info.model!;
    assertEquals([applied.providerID, applied.modelID], ["fake", "scripted"]);
    assertEquals(b.errors, []);
  } finally {
    await client?.close();
    await f.stop();
  }
});
