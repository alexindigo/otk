// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createServer } from "vite";
import solid from "@solidjs/vite-plugin";

async function verify(): Promise<void> {
  const root = new URL("../../../", import.meta.url).pathname;
  const cacheDir = await Deno.makeTempDir({ prefix: "command-sentinel-vite-" });
  const server = await createServer({
    configFile: false,
    cacheDir,
    root: new URL("command-sentinel-consumer/", import.meta.url).pathname,
    resolve: {
      alias: {
        "@otk/client": root + "packages/client/mod.ts",
        "@otk/protocol": root + "packages/protocol/mod.ts",
      },
    },
    plugins: [
      solid({
        compiler: "native",
        hot: false,
        solid: { delegateEvents: false },
      }),
    ],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  });
  try {
    await server.listen();
    const script = `
      import { chromium } from "./tests/browser/node_modules/playwright/index.mjs";
      const browser = await chromium.launch({headless:true});
      try {
        const page = await browser.newPage();
        page.on("pageerror", error => console.error(error));
        await page.goto(process.argv[1]);
        const result = page.locator("output[data-sentinel]");
        await result.waitFor();
        const name = await result.getAttribute("data-sentinel");
        const names = JSON.parse(await result.textContent());
        if (!names.includes(name)) throw new Error("Missing slash sentinel " + name);
        await page.locator('[data-command="' + name + '"]').waitFor();
        console.log("Random registration reached Palette and slash:", name);
      } finally { await browser.close(); }
    `;
    const result = await new Deno.Command("node", {
      args: [
        "--input-type=module",
        "-e",
        script,
        server.resolvedUrls!.local[0],
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    assertEquals(result.code, 0);
  } finally {
    await server.close();
    await Deno.remove(cacheDir, { recursive: true });
  }
}
await verify();
