// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
Deno.test("R7 host preferences control real reasoning, persist on reload and propagate to an independent browser", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Preferences" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    f.fake.queue({
      reasoning: [
        "**Checking preferences**\n\n",
        "Reasoning body visible only when expanded.",
      ],
      chunks: ["Preference proof."],
      delay: 150,
    });
    await browser.type("textarea[name=prompt]", "Reason about the display");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('.otk-reasoning > button')?.textContent.includes('Thought')",
    );
    await waitForReply(browser, session.id, "Preference proof.");
    await browser.poll("!document.querySelector('.otk-reasoning-body')");
    await browser.click(".otk-reasoning > button");
    await browser.poll(
      "document.querySelector('.otk-reasoning-body')?.textContent.includes('Reasoning body visible')",
    );
    await browser.click(".otk-display-menu > button");
    await browser.poll(
      "!document.querySelector('.otk-display-menu fieldset').disabled",
    );
    await browser.click("select[name=thinking]");
    await browser.key("ArrowDown");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('select[name=thinking]').value === 'show'",
    );
    await browser.click("input[name=timestamps]");
    await browser.poll(
      "getComputedStyle(document.querySelector('.otk-user-meta time')).visibility==='visible'",
    );
    await browser.reload();
    await browser.poll(
      "!!document.querySelector('.otk-reasoning-body') && document.querySelector('select[name=thinking]').value === 'show'",
    );
    const second = await f.browser(server.url + `/#/local/${session.id}`);
    await second.poll("!!document.querySelector('.otk-reasoning-body')");
    await browser.click(".otk-display-menu > button");
    await browser.click("select[name=thinking]");
    await browser.key("ArrowUp");
    await browser.key("Enter");
    await browser.poll(
      "!document.querySelector('.otk-reasoning-body') && document.querySelector('select[name=thinking]').value === 'hide'",
    );
    await second.poll(
      "!document.querySelector('.otk-reasoning-body') && document.querySelector('select[name=thinking]').value === 'hide'",
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) => frame.method === "prefs.set")
        .length,
      3,
    );
    await browser.screenshot(join(f.oc.root, "r7-hidden-reasoning.png"));
  } finally {
    await f.stop();
  }
});
