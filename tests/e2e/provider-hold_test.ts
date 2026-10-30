// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { test } from "../support/resources.ts";

for (const kind of ["held", "stepped"]) {
  test(`consumer-owned ${kind} reply survives native SSE inactivity without content or retry`, async () => {
    const f = await browserFixture();
    try {
      // Exercise the stock idle boundary in seconds, rather than waiting for
      // its five-minute default in this focused fixture regression.
      // OPENCODE_PURE isolates the fixture to its global config, so update that
      // owned input and restart before any prompt/provider cache is admitted.
      const path = join(f.oc.root, "config/opencode/opencode.json");
      const input = JSON.parse(await Deno.readTextFile(path));
      input.provider.fake.options.chunkTimeout = 2000;
      await Deno.writeTextFile(path, JSON.stringify(input));
      await f.oc.restart();
      const config = await f.oc.request<{
        provider: { fake: { options: { chunkTimeout: number } } };
      }>("/config");
      assertEquals(config.provider.fake.options.chunkTimeout, 2000);
      const session = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Consumer-owned stream" },
      });
      const server = await f.sidecar();
      const browser = await f.browser(server.url);
      await openSession(browser, session.id);
      const held = kind === "held"
        ? f.fake.queueHeld({ chunks: ["Held output"] })
        : undefined;
      const stepped = kind === "stepped"
        ? f.fake.queueStepped({ chunks: ["Held output", " Released"] })
        : undefined;
      stepped?.next();
      const prompt = "Wait for the fixture consumer";
      const calls = () =>
        f.fake.requests.filter((request) => {
          const body = JSON.stringify(request);
          return body.includes(prompt) &&
            !body.includes("Generate a title for this conversation:");
        });
      await browser.fill("textarea[name=prompt]", prompt);
      await browser.key("Enter");
      const output =
        "document.querySelector('[data-role=assistant] .otk-text')?.textContent";
      const busy =
        `document.querySelector('[data-session="${session.id}"]')?.dataset.status==='busy'`;
      await browser.poll(`${output}==='Held output' && ${busy}`);
      await new Promise((resolve) => setTimeout(resolve, 6500));
      assertEquals(
        calls().length,
        1,
        "A consumer gate must not retry the model",
      );
      assertEquals(await browser.evaluate(busy), true);
      assertEquals(await browser.evaluate(output), "Held output");
      held?.release();
      stepped?.next();
      await waitForReply(
        browser,
        session.id,
        kind === "held" ? "Held output" : "Held output Released",
      );
      assertEquals(calls().length, 1);
    } finally {
      await f.stop();
    }
  });
}
