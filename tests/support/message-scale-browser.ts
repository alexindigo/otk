// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { start } from "../../main.ts";
import { staticResponse } from "../../core/mod.ts";
import { cfg } from "./config.ts";
import { Cdp } from "./cdp.ts";
import { FakeLlm } from "./fake-llm.ts";
import { MESSAGE_CASES } from "./message-scale-cases.ts";
import { freePort, waitFor } from "./opencode.ts";
import { resources } from "./resources.ts";
import { servingProbe } from "./serving-probe.ts";
import { SCALE, SessionScale } from "./session-scale.ts";
import { WsClient } from "./ws-client.ts";
import { consumerAssets } from "./consumer-builds.ts";

/** Real stock population and an independent public UI consumer, not a debug RPC. */
export async function messageScaleBrowser(
  root: string,
  options: { theme: string; index?: number; latency?: number },
) {
  const fake = new FakeLlm();
  const native = await SessionScale.create(join(root, "fixture"), root, fake, {
    messages: true,
  });
  const index = options.index ?? 0, target = native.manifest.sessions[index];
  const first = native.manifest.sessions.slice(0, index).reduce(
    (n, s) => n + s.expected.messages,
    0,
  );
  const assets = await consumerAssets("message-heap");
  const ui = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) =>
      staticResponse(new URL(request.url).pathname, { staticRoot: assets }),
  );
  resources().defer("scale consumer UI server", () => ui.shutdown());
  const uiURL = `http://127.0.0.1:${ui.addr.port}`;
  const reads: { at: number; before: boolean; ended?: number }[] = [];
  const proxy = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const uri = new URL(request.url);
      if (uri.pathname === `/session/${target.nativeID}/message`) {
        const read = {
          at: performance.now(),
          before: uri.searchParams.has("before"),
          ended: undefined as number | undefined,
        };
        reads.push(read);
        if (options.latency) {
          await new Promise((resolve) => setTimeout(resolve, options.latency));
        }
        const response = await fetch(
          new Request(new URL(uri.pathname + uri.search, native.url), request),
        );
        read.ended = performance.now();
        return response;
      }
      return await fetch(
        new Request(new URL(uri.pathname + uri.search, native.url), request),
      );
    },
  );
  resources().defer("scale consumer native proxy", () => proxy.shutdown());
  const config = cfg();
  config.auth.type = "none";
  config.server.port = freePort();
  config.server.origins = [uiURL];
  config.state.path = join(root, "state");
  config.harness.url = `http://127.0.0.1:${proxy.addr.port}`;
  config.harness.db = native.db;
  const serving = servingProbe(false);
  resources().defer("scale serving probe", () => serving.stop());
  const app = await start(config, {
    admission: serving.start,
    section: serving.section,
  });
  resources().defer("scale consumer sidecar", () => app.stop());
  const api = `http://127.0.0.1:${config.server.port}`;
  const client = new WsClient(api);
  await client.connect();
  await waitFor(
    () => app.index.get(native.manifest.sessions.at(-1)!.id),
    Boolean,
    120000,
  );
  // Catalog metadata is published before native bootstrap finishes. Join live
  // event readiness before a stepped producer can wait on its consumer frame.
  await client.wait(
    (frame) => frame.t === "harness" && frame.state === "connected",
    120000,
  );
  await client.rpc("prefs.set", { key: "theme", value: options.theme });
  const browser = await Cdp.launch(root);
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const url = new URL(uiURL);
  url.searchParams.set("api", api);
  url.searchParams.set("a", target.id);
  url.searchParams.set("b", native.manifest.sessions[MESSAGE_CASES.code].id);
  url.searchParams.set("directory", target.directory);
  url.searchParams.set("oldest", `msg_scale${String(first).padStart(9, "0")}`);
  url.searchParams.set("probe", "1");
  url.searchParams.set("theme", options.theme);
  resources().evidence("scale consumer outcomes", async () => {
    await Deno.writeTextFile(
      join(root, "scale-outcomes.json"),
      JSON.stringify(
        {
          version: native.manifest.version,
          counts: SCALE,
          target,
          reads,
          serving: serving.samples,
          errors: browser.errors,
        },
        null,
        2,
      ),
    );
    await Deno.writeTextFile(
      join(root, "scale-browser.json"),
      await browser.evaluate<string>("JSON.stringify(scaleMeasurements)"),
    );
    await Deno.writeTextFile(
      join(root, "scale-browser.html"),
      await browser.evaluate<string>("document.documentElement.outerHTML"),
    );
  });
  await browser.goto(url.toString());
  await browser.poll(
    "document.querySelectorAll('.heap-preview .otk-token').length>0",
    60000,
  );
  await browser.click("#heap-open-a");
  await browser.poll(
    "Number(document.querySelector('#heap-state').dataset.aCount)>=20",
    60000,
  );
  await browser.evaluate("document.fonts.ready");
  return { native, fake, browser, app, client, target, reads, serving, uiURL };
}
