// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Cdp } from "./cdp.ts";
import { serve } from "./http.ts";

/** Independent browser composition for the public tab and lazy-source consumers. */
export async function remainingBrowser(root: string, query = "") {
  const dist = join(root, "dist");
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "tests/support/remaining-consumer/vite.config.ts",
      "--outDir",
      dist,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      try {
        return new Response(
          await Deno.readFile(join(dist, path === "/" ? "index.html" : path)),
          {
            headers: {
              "content-type": path.endsWith(".js")
                ? "text/javascript"
                : path.endsWith(".css")
                ? "text/css"
                : "text/html",
            },
          },
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        return new Response("Not found", { status: 404 });
      }
    },
  );
  const browser = await Cdp.launch(root),
    url = `http://127.0.0.1:${server.addr.port}`;
  await browser.goto(url + "/" + query);
  return {
    browser,
    url,
    close: async () => {
      await browser.close();
      await server.shutdown();
    },
  };
}
