// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FakeLlm } from "./fake-llm.ts";
import { OpencodeTest } from "./opencode.ts";
import { SidecarTest } from "./sidecar.ts";
import { Cdp } from "./cdp.ts";
export async function browserFixture() {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const servers: SidecarTest[] = [], browsers: Cdp[] = [];
  return {
    fake,
    oc,
    async sidecar(overrides: Parameters<typeof SidecarTest.start>[1] = {}) {
      const sidecar = await SidecarTest.start(oc, overrides);
      servers.push(sidecar);
      return sidecar;
    },
    async browser(url: string) {
      const browser = await Cdp.launch(oc.root);
      browsers.push(browser);
      await browser.goto(url);
      return browser;
    },
    async stop() {
      const errors = browsers.flatMap((browser) => browser.errors);
      try {
        await Deno.writeTextFile(
          join(oc.root, "provider-requests.json"),
          JSON.stringify(fake.requests, null, 2),
        );
        for (const [i, browser] of browsers.entries()) {
          await browser.dismissDialog();
          await Deno.writeTextFile(
            join(oc.root, `browser-${i}.html`),
            await browser.evaluate<string>(
              "document.documentElement.outerHTML",
            ),
          );
          await Deno.writeTextFile(
            join(oc.root, `browser-${i}-frames.json`),
            JSON.stringify(
              browser.events.filter((event) =>
                event.method.startsWith("Network.webSocket")
              ),
              null,
              2,
            ),
          );
        }
        console.info("Browser fixture evidence:", oc.root);
      } finally {
        for (const browser of browsers) await browser.close();
        for (const server of servers) await server.stop();
        await oc.stop();
        await fake.stop();
      }
      assertEquals(errors, [], "Uncaught browser exception");
    },
  };
}
export async function openSession(browser: Cdp, id: string): Promise<void> {
  await browser.poll(`!!document.querySelector('[data-session="${id}"]')`);
  await browser.click(`[data-session="${id}"]`);
  await browser.poll(
    `location.hash.endsWith('/${id}') && document.querySelector('[data-session="${id}"]')?.getAttribute('aria-current') === 'page' && !!document.querySelector('.otk-prompt') && ![...document.querySelectorAll('.otk-messages > p')].some(el=>el.textContent === 'Loading messages…')`,
  );
}
export function sentFrames(
  browser: Cdp,
): { time: number; frame: Record<string, unknown> }[] {
  return browser.events.filter((event) =>
    event.method === "Network.webSocketFrameSent"
  ).map((event) => ({
    time: event.params.timestamp as number,
    frame: JSON.parse(
      (event.params.response as { payloadData: string }).payloadData,
    ),
  }));
}
export const streamReply =
  "# Streaming\n\nAn incremental reply.\n\n- first\n- second\n\n```ts\nconst otk = 1;\n```\n";
export const streamScript = () => ({
  chunks: Array.from({ length: 20 }, (_, i) =>
    streamReply.slice(
      Math.floor(i * streamReply.length / 20),
      Math.floor((i + 1) * streamReply.length / 20),
    )),
  delay: 50,
});
