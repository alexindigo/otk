// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FakeLlm } from "./fake-llm.ts";
import { OpencodeTest } from "./opencode.ts";
import { SidecarTest } from "./sidecar.ts";
import { Cdp } from "./cdp.ts";
import { acquire, resources } from "./resources.ts";
export async function browserFixture(
  permission?: Record<string, "ask" | "allow" | "deny">,
  options?: Parameters<typeof OpencodeTest.start>[2],
) {
  return await acquire("browser fixture", async () => {
    const scope = resources();
    const fake = new FakeLlm(),
      oc = await OpencodeTest.start(fake, permission, options);
    const servers: SidecarTest[] = [], browsers: Cdp[] = [];
    let stopping: Promise<void> | undefined;
    scope.evidence(
      "provider evidence",
      () =>
        Deno.writeTextFile(
          join(oc.root, "provider-requests.json"),
          JSON.stringify(fake.requests, null, 2),
        ),
    );
    for (const [id, provider] of Object.entries(options?.providers ?? {})) {
      scope.evidence(`provider ${id} evidence`, () =>
        Deno.writeTextFile(
          join(oc.root, `provider-${encodeURIComponent(id)}-requests.json`),
          JSON.stringify(provider.fake.requests, null, 2),
        ));
    }
    scope.evidence("browser exceptions", () => {
      assertEquals(
        browsers.flatMap((browser) => browser.errors),
        [],
        "Uncaught browser exception",
      );
    });
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
        const i = browsers.push(browser) - 1;
        scope.evidence(`browser ${i} evidence`, async () => {
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
        });
        await browser.goto(url);
        return browser;
      },
      async stop() {
        await (stopping ??= (async () => {
          await scope.capture();
          for (const browser of browsers.toReversed()) {
            await scope.observe("browser close", () => browser.close());
          }
          for (const server of servers.toReversed()) {
            await scope.observe("sidecar stop", () => server.stop());
          }
          await scope.observe("native stop", () => oc.stop());
          await scope.observe("provider stop", () => fake.stop());
          for (const provider of Object.values(options?.providers ?? {})) {
            await scope.observe(
              "extra provider stop",
              () => provider.fake.stop(),
            );
          }
        })());
      },
    };
  });
}
export async function openSession(browser: Cdp, id: string): Promise<void> {
  await browser.poll("!!document.querySelector('.otk-right-panel')");
  // Decide from the received host layout, not the pre-handshake default. Another
  // browser may already have persisted an open panel before this one connects.
  await browser.poll(
    "!!document.querySelector('.otk-corner-right:not(:disabled)')",
  );
  if (
    await browser.evaluate("document.querySelector('.otk-right-panel').hidden")
  ) {
    await browser.click('[aria-label="Open right panel"]');
    await browser.poll("!document.querySelector('.otk-right-panel').hidden");
  }
  await browser.click('[data-panel-view="sessions"]');
  await browser.poll(
    `!!document.querySelector('[data-session="${id}"]') || !!document.querySelector('[data-project-sessions~="${id}"]')`,
  );
  if (
    !await browser.evaluate(
      `!!document.querySelector('[data-session="${id}"]')`,
    )
  ) {
    await browser.click(`[data-project-sessions~="${id}"] .otk-project-open`);
  }
  await browser.poll(`!!document.querySelector('[data-session="${id}"]')`);
  await browser.click(`[data-session="${id}"]`);
  await browser.poll(
    `location.hash.endsWith('/${id}') && document.querySelector('[data-session="${id}"]')?.getAttribute('aria-current') === 'page' && (!!document.querySelector('.otk-prompt') || !!document.querySelector('.otk-subagent-bar')) && ![...document.querySelectorAll('.otk-messages > p')].some(el=>el.textContent === 'Loading messages…')`,
  );
}
/** Independent collapse intents must both reach the screen, including on reload. */
export async function waitForCollapsedPanels(browser: Cdp): Promise<void> {
  await browser.poll(
    "document.querySelector('.otk-project-inbox')?.dataset.collapsed==='true' && document.querySelector('.otk-right-panel')?.hidden===true",
  );
}
/** A terminal part is not a terminal reply: content and idle must both arrive. */
export async function waitForReply(
  browser: Cdp,
  sessionID: string,
  text: string,
): Promise<void> {
  await browser.poll(
    `document.querySelector('[data-session="${sessionID}"]')?.dataset.status==='idle' && [...document.querySelectorAll('[data-role=assistant] .otk-text')].some(el=>el.textContent===${
      JSON.stringify(text)
    }) && [...document.querySelectorAll('.otk-message-footer')].every(el=>!el.textContent.includes('streaming'))`,
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
