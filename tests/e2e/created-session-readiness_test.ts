// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  browserFixture,
  sentFrames,
  streamScript,
} from "../support/browser-fixture.ts";

Deno.test("created-session readiness: trusted send reaches the provider and transcript while index delivery is held", async () => {
  const f = await browserFixture();
  try {
    const seed = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Existing project" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    // Hold only index delivery. Native creation, content, inbox and command
    // acknowledgements remain real and unmodified; release replays every frame.
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.heldIndex = [];
        window.holdIndex = false;
        window.WebSocket = class extends WebSocket {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', event => {
              const frame = JSON.parse(event.data);
              if (window.holdIndex && (frame.t === 'index.patch' || frame.t === 'index.snapshot')) {
                event.stopImmediatePropagation();
                window.heldIndex.push(() => this.dispatchEvent(new MessageEvent('message', {data:event.data})));
              }
            });
          }
        };
        window.releaseIndex = () => {
          window.holdIndex = false;
          for (const deliver of window.heldIndex.splice(0)) deliver();
        };
      `,
    });
    await browser.reload();
    await browser.poll("!!document.querySelector('.otk-project-open')");
    await browser.click(".otk-project-open");
    await browser.poll(
      "!!document.querySelector('.otk-new-session:not(:disabled)')",
    );
    await browser.evaluate("window.holdIndex = true");
    await browser.click(".otk-new-session");
    await browser.poll(
      `!!document.querySelector('.otk-prompt') && location.hash.startsWith('#/local/') && !location.hash.endsWith('/${seed.id}')`,
    );
    const id = await browser.evaluate<string>(
      "location.hash.split('/').at(-1)",
    );
    f.fake.queue(streamScript());
    await browser.type(
      "textarea[name=prompt]",
      "Show the scripted markdown before index delivery",
    );
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-role=assistant] .otk-text')?.textContent.includes('const otk = 1;')",
    );
    assert(
      f.fake.requests.length > 0,
      "The native provider must receive the trusted prompt",
    );
    assert(
      await browser.evaluate<boolean>(
        "window.holdIndex && window.heldIndex.length > 0",
      ),
    );
    assertEquals(
      await browser.evaluate(
        `!!document.querySelector('[data-session="${id}"]')`,
      ),
      false,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-prompt [role=alert]')?.textContent || ''",
      ),
      "",
    );
    const methods = sentFrames(browser).map(({ frame }) => frame.method);
    assert(methods.includes("tasks.create"));
    assert(methods.includes("session.prompt"));
    await browser.evaluate("window.releaseIndex()");
    await browser.poll(
      `document.querySelector('[data-session="${id}"]')?.dataset.status === 'idle' && document.querySelector('[data-crumb="${id}"]')?.getAttribute('aria-current') === 'page' && !!document.querySelector('.otk-text pre')`,
    );
  } finally {
    await f.stop();
  }
});
