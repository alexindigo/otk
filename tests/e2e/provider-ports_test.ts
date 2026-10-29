// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { staticResponse } from "../../core/mod.ts";
import { Cdp } from "../support/cdp.ts";
import { resources, tempDir, test } from "../support/resources.ts";

test("public provider ports exclude render props, remain live and copy without constructing children", async () => {
  const root = await tempDir("pp-"), dist = join(root, "dist");
  const built = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "tests/support/provider-ports-consumer/vite.config.ts",
      "--outDir",
      dist,
      "--logLevel",
      "warn",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(built.code, 0, new TextDecoder().decode(built.stderr));
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) =>
      staticResponse(new URL(request.url).pathname, { staticRoot: dist }),
  );
  resources().defer("provider consumer server", () => server.shutdown());
  const browser = await Cdp.launch(root);
  await browser.goto(`http://127.0.0.1:${server.addr.port}`);
  await browser.poll("document.querySelector('#mounts')?.textContent==='1'");
  const text = (id: string) =>
    browser.evaluate(`document.querySelector('#${id}').textContent`);
  assertEquals(await text("port-keys"), "commands,keyboard");
  assertEquals(await text("identity"), "true");
  assertEquals(await text("keyboard"), "true");
  await browser.click("#copy-ports");
  await browser.poll("document.querySelector('#copied').textContent==='0'");
  assertEquals(await text("mounts"), "1");
  await browser.click("#replace-ports");
  await browser.poll(
    "document.querySelector('#identity').textContent==='true' && document.querySelector('#keyboard').textContent==='true'",
  );
  await browser.click("#copy-ports");
  await browser.poll("document.querySelector('#copied').textContent==='1'");
  assertEquals(await text("mounts"), "1");
  await browser.click("#toggle-consumer");
  await browser.poll(
    "!document.querySelector('#consumer') && document.querySelector('#releases').textContent==='1'",
  );
  await browser.click("#toggle-consumer");
  await browser.poll("document.querySelector('#mounts').textContent==='2'");
  assertEquals(
    await browser.evaluate(
      "document.querySelector('#consumer').dataset.construction",
    ),
    "2",
  );
  assertEquals(await text("releases"), "1");
  assertEquals(browser.errors, []);
});
