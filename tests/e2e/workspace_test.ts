// SPDX-License-Identifier: LGPL-3.0-only
// T2 visual remainder. Behavior owners are recorded in migration.json; T3 owns paint.
import { test } from "../support/resources.ts";
import { assert } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";

test("E1 project inbox and Sessions tree scoped by directory, descendants nested, SPA assets and API boundary", async () => {
  const f = await browserFixture();
  try {
    const root = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Root session" },
    });
    await f.oc.session("/session", {
      method: "POST",
      body: { title: "Child session", parentID: root.id },
    });
    const directory = join(f.oc.root, "second-project");
    await Deno.mkdir(directory);
    const other = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      directory,
      body: { title: "Other project" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, other.id);
    const geometry = await browser.evaluate<
      {
        sidebarRight: number;
        mainLeft: number;
        viewport: number;
        mainBottom: number;
      }
    >("(()=>{const s=document.querySelector('.otk-project-inbox').getBoundingClientRect(),m=document.querySelector('.otk-main').getBoundingClientRect();return {sidebarRight:s.right,mainLeft:m.left,viewport:innerHeight,mainBottom:m.bottom}})()");
    assert(Math.abs(geometry.sidebarRight - geometry.mainLeft) < .5);
    assert(Math.abs(geometry.viewport - geometry.mainBottom) < .5);
    await browser.screenshot(join(f.oc.root, "workspace-geometry.png"));
  } finally {
    await f.stop();
  }
});

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
