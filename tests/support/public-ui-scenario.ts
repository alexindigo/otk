// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { fixture } from "./config.ts";
import { serve } from "./http.ts";
import { consumerAssets } from "./consumer-builds.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type { ControlRequest, TestLease } from "./fixture-control.ts";
/** Prebuilt independent public-entry UI, without acquiring a native backend. */
export async function publicUiScenario() {
  const root = await fixture(), dist = await consumerAssets("ui");
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const pathname = new URL(request.url).pathname,
        file = join(dist, pathname === "/" ? "index.html" : pathname),
        mime = file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
          ? "text/css"
          : "text/html";
      try {
        return new Response(await Deno.readFile(file), {
          headers: { "content-type": mime },
        });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        return new Response("Not found", { status: 404 });
      }
    },
  );
  const info = {
    root,
    url: `http://127.0.0.1:${server.addr.port}`,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [server.addr.port],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  let lease: TestLease | undefined;
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign public UI lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Public UI already leased");
          lease = { lease: crypto.randomUUID(), directory: root, baseline: {} };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return {};
        case "stop":
          await server.shutdown();
          return null;
        default:
          throw new Error("Command outside public UI scenario");
      }
    },
  };
}
