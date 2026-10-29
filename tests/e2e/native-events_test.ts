// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { staticResponse } from "../../core/mod.ts";
import { Cdp } from "../support/cdp.ts";
import { assertContentReleased, sessionHeap } from "../support/heap.ts";
import { resources, tempDir, test } from "../support/resources.ts";

async function consumer() {
  const root = await tempDir("ne-"), dist = join(root, "dist");
  const marker = `OTK_NATIVE_EVENT_${crypto.randomUUID()}_`;
  const built = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "packages/ui/tests/native-events-consumer/vite.config.ts",
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
      new URL(request.url).pathname === "/source"
        ? new Response(marker + "native-source ".repeat(8192), {
          headers: { "cache-control": "no-store" },
        })
        : staticResponse(new URL(request.url).pathname, { staticRoot: dist }),
  );
  resources().defer("native event consumer", () => server.shutdown());
  const browser = await Cdp.launch(root);
  await browser.goto(`http://127.0.0.1:${server.addr.port}`);
  await browser.poll(
    "document.querySelector('#event-editor')?.value.length>100000",
  );
  await browser.click("#event-editor");
  await browser.key("ArrowLeft");
  await browser.poll(
    "document.querySelector('#event-count').textContent==='1'",
  );
  assertEquals(
    await browser.evaluate(
      "document.querySelector('#event-target').textContent",
    ),
    "event-editor",
  );
  return { browser, marker };
}
test("forwarded native keyboard handlers use the DOM currentTarget without installing a retaining getter", async () => {
  const { browser } = await consumer();
  assertEquals(
    await browser.evaluate(
      "document.querySelector('#event-getter').textContent",
    ),
    "false",
  );
  assertEquals(browser.errors, []);
});
test("retired input source is released after a real key event without requiring another key event", async () => {
  const { browser, marker } = await consumer();
  await browser.click("#retire-editor");
  await browser.poll("!document.querySelector('#event-editor')");
  await browser.evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  assertContentReleased(
    await sessionHeap(browser, "native-event-input", marker),
  );
  assertEquals(browser.errors, []);
});
test("native attribute forwarding replaces live attributes, preserves once/capture and tuple receivers, and removes retired handlers", async () => {
  const { browser } = await consumer();
  await browser.click("#forwarded-button");
  await browser.poll("document.querySelector('#clicks').textContent==='1'");
  await browser.click("#forwarded-button");
  assertEquals(
    await browser.evaluate("document.querySelector('#clicks').textContent"),
    "1",
  );
  await browser.click("#replace-handler");
  await browser.poll(
    "document.querySelector('#tuple-button')?.getAttribute('aria-label')==='Replacement attributes'",
  );
  await browser.click("#tuple-button");
  await browser.poll("document.querySelector('#clicks').textContent==='3'");
  assertEquals(
    await browser.evaluate("document.querySelector('#receiver').textContent"),
    "tuple-button:tuple-button",
  );
  await browser.click("#tuple-button");
  await browser.poll("document.querySelector('#clicks').textContent==='5'");
  await browser.click("#remove-handler");
  await browser.poll(
    "document.querySelector('#tuple-button').getAttribute('aria-label')==='No handler'",
  );
  await browser.click("#tuple-button");
  assertEquals(
    await browser.evaluate("document.querySelector('#clicks').textContent"),
    "5",
  );
  assertEquals(browser.errors, []);
});
