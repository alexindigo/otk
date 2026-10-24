// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fixture } from "./config.ts";
import { serve } from "./http.ts";
import { Cdp } from "./cdp.ts";

/** Build and serve the independent public-entry consumer, with owned teardown. */
export async function uiConsumer(query = "") {
  const root = await fixture(), dist = join(root, "dist");
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "tests/reuse/ui-consumer/vite.config.ts",
      "--outDir",
      dist,
      "--logLevel",
      "warn",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const pathname = new URL(request.url).pathname;
      const file = join(dist, pathname === "/" ? "index.html" : pathname);
      const mime = file.endsWith(".js")
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
  const browser = await Cdp.launch(root);
  await browser.goto(`http://127.0.0.1:${server.addr.port}/${query}`);
  return {
    root,
    browser,
    async close() {
      await browser.close();
      await server.shutdown();
    },
  };
}
