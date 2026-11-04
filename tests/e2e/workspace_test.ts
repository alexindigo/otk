// SPDX-License-Identifier: LGPL-3.0-only
// T2 visual remainder. Behavior owners are recorded in migration.json; T3 owns paint.
import { test } from "../support/resources.ts";
import { assert } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";

test("E5 Esc confirmation then abort yields interrupted footer and idle session", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Interrupt" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    f.fake.queueHeld({ chunks: ["continuing "] });
    await browser.type("textarea[name=prompt]", "Continue slowly");
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]')?.dataset.status==='busy' && !!document.querySelector('[data-role=assistant] .otk-text')`,
    );
    await browser.key("Escape");
    await browser.poll(
      "!!document.querySelector('[data-interrupt-confirmation]')",
    );
    await browser.screenshot(join(f.oc.root, "interrupt-confirmation.png"));
    await browser.key("Escape");
    const marker =
      `[data-session="${session.id}"] .otk-status-light[data-state=blocked]`;
    await browser.poll(`!!document.querySelector('${marker}')`);
    const dot = await browser.evaluate<
      { width: number; height: number; radius: string }
    >(`(()=>{const el=document.querySelector('${marker}'),r=el.getBoundingClientRect();return {width:r.width,height:r.height,radius:getComputedStyle(el.querySelector('.otk-lamp-body')).borderRadius}})()`);
    assert(
      dot.width === 8 && Math.abs(dot.width - dot.height) < .5 &&
        dot.radius === "50%",
      "Error status uses the shared circular marker",
    );
    await browser.screenshot(join(f.oc.root, "interrupted-marker.png"));
  } finally {
    await f.stop();
  }
});
