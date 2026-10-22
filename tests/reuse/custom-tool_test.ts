// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { serve } from "../support/http.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";

test("independent public UI consumer renders external tools twice, updates live, routes callbacks and retains isolated fallback", async () => {
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
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  );
  let browser: Cdp | undefined;
  try {
    browser = await Cdp.launch(root);
    await browser.goto(`http://127.0.0.1:${server.addr.port}/`);
    await browser.poll(
      "document.querySelectorAll('#registered [data-external-tool]').length === 2",
    );
    await browser.poll(
      "!!document.querySelector('[data-library-code] .otk-token')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-library-code] code').textContent",
      ),
      "const externalResult: number = 7;",
    );
    const tokenColor =
      "getComputedStyle(document.querySelector('[data-library-code] .otk-token')).color";
    const dark = await browser.evaluate(tokenColor);
    await browser.click("[data-light]");
    await browser.poll(
      "document.documentElement.dataset.otkTheme==='otk-light'",
    );
    assertEquals(await browser.evaluate(tokenColor) === dark, false);
    await browser.click("[data-dark]");
    await browser.poll(
      "document.documentElement.dataset.otkTheme==='otk-dark'",
    );
    assertEquals(await browser.evaluate(tokenColor), dark);
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('#isolated [data-external-tool]').length",
      ),
      0,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('#isolated .otk-tool-toggle').textContent.includes('external-probe Initial result')",
      ),
      true,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('#isolated .otk-tool-verb').textContent",
      ),
      "external-probe",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('#isolated .otk-tool-brief').textContent",
      ),
      "Initial result",
    );
    await browser.click("#isolated .otk-tool-toggle");
    await browser.poll(
      "!document.querySelector('#isolated .otk-tool-body').hidden && document.querySelector('#isolated .otk-tool-output').textContent==='Reusable output'",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('#isolated .otk-tool-body .otk-tool-summary')",
      ),
      null,
    );
    await browser.click("[data-update]");
    await browser.poll(
      "document.querySelector('#registered .otk-tool-toggle').textContent.includes('Inspect') && document.querySelector('#registered .otk-tool-toggle').textContent.includes('external target')",
    );
    await browser.click("#registered .otk-tool-toggle");
    await browser.poll(
      "!document.querySelector('#registered .otk-tool-body').hidden",
    );
    await browser.poll(
      "[...document.querySelectorAll('[data-external-tool] .otk-tool-summary')].every(el=>el.textContent.includes('Updated result'))",
    );
    await browser.click("[data-open]");
    await browser.poll(
      "document.querySelector('#opened').textContent === 'child-probe'",
    );
    await browser.poll(
      "document.querySelector('[data-external-part]').textContent === 'Injected part: agent'",
    );
    await browser.poll(
      "document.querySelector('[data-typed-part]').textContent === 'Feature part: Updated result'",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('#registered').textContent.includes('Unsupported part: future.card')",
      ),
      true,
    );
    await browser.click("[data-inject]");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value === 'Injected draft'",
    );
    await browser.poll(
      "document.querySelector('.otk-prompt-context > span:first-child')?.textContent==='External-Agent'",
    );
    await browser.click("textarea[name=prompt]");
    await browser.poll(
      "document.activeElement===document.querySelector('textarea[name=prompt]')",
    );
    assertEquals(
      await browser.evaluate("document.activeElement.closest('.otk-composer')"),
      null,
    );
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.activeElement).outlineStyle",
      ),
      "solid",
      "A standalone Prompt retains its own visible field focus",
    );
    await browser.click(".otk-prompt button[type=submit]");
    await browser.poll(
      "document.querySelector('#submitted').textContent.includes('external transform') && document.querySelector('textarea[name=prompt]').value === ''",
    );
    assertEquals(
      await browser.evaluate(
        "JSON.parse(document.querySelector('#submitted').textContent)",
      ),
      [
        { kind: "text", text: "Injected draft" },
        { kind: "text", text: "external transform" },
      ],
    );
    assertEquals(browser.errors, []);
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-external-dock]') === null",
      ),
      true,
    );
    await browser.click("[data-capability]");
    await browser.poll("!!document.querySelector('[data-external-dock]')");
    await browser.click("[data-external-dock]");
    await browser.poll(
      "document.querySelector('[data-external-dock]').textContent === 'Injected dock 1'",
    );
    await browser.poll("!!document.querySelector('[data-external-takeover]')");
    await browser.click("[data-external-takeover]");
    await browser.poll(
      "document.querySelector('#opened').textContent==='typed external reply'",
    );
    await browser.click("[data-open-dialog]");
    await browser.poll(
      "document.querySelector('[data-external-dialog]')?.textContent.includes('Feature-owned dialog')",
    );
    await browser.click("[data-close-dialog]");
    await browser.poll("!document.querySelector('[data-external-dialog]')");
    await browser.click(".otk-display-menu > button");
    await browser.poll(
      `!![...document.querySelectorAll('.otk-display-menu label')].find(el => el.textContent.includes('Consumer compact layout'))`,
    );
    await browser.click('input[name="consumer.compact"]');
    await browser.poll(
      `document.querySelector('[data-consumer-preference]').textContent === 'true' && document.querySelector('input[name="consumer.compact"]').checked`,
    );
    assertEquals(browser.errors, []);
    console.info("Independent UI consumer evidence:", root);
  } finally {
    await browser?.close();
    await server.shutdown();
  }
});
