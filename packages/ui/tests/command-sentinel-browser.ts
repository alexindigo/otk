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
        const command = page.locator('[data-command-name="' + name + '"]');
        await command.waitFor();
        if (await command.getAttribute("data-command") === name) {
          throw new Error("Sentinel must exercise distinct registry name and opaque ID");
        }
        await page.getByRole("button", {name:"Sentinel menu", exact:true}).click();
        const item = page.locator(':popover-open [data-context-command-name="' + name + '"]');
        await item.click();
        if (await page.locator("body").getAttribute("data-executed") !== name) {
          throw new Error("Named menu item did not invoke its registry owner");
        }
        console.log("Random registration reached Palette, slash and context menu:", name);
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
