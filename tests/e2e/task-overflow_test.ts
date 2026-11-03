// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";
import { resources, test } from "../support/resources.ts";

// C14 owns native More/navigation and mandatory-task behavior. Retain fixed V scenes.
test("251 idle tasks occupy one measured row; selected and attention tasks stay visible and only pins wrap", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  await c.connect();
  const directory = f.entries[0].directory,
    ids: string[] = [],
    tasks: string[] = [];
  for (let n = 0; n < 251; n++) {
    const id = `tstv1-task-${n}`;
    ids.push(id);
    f.add({ ...f.entries[0], id, title: `Session ${n}` });
    tasks.push(
      (await c.rpc<{ id: string }>("tasks.create", {
        directory,
        name: `Qualification task ${n}`,
        sessions: [id],
      })).id,
    );
  }
  await c.rpc("layout.patch", { leftCollapsed: true, rightCollapsed: true });
  await b.goto(`${f.url}/#/local/${ids[0]}`);
  await b.poll(
    "!!document.querySelector('textarea[name=prompt]')&&!!document.querySelector('.otk-task-list [data-tab]')",
  );
  const geometry = () =>
    b.evaluate<
      { height: number; expected: number; visible: string[]; pinned: string[] }
    >(`(()=>{const strip=document.querySelector('.otk-task-strip');return {height:strip.getBoundingClientRect().height,expected:parseFloat(getComputedStyle(strip).getPropertyValue('--chrome-header-height')),visible:[...strip.querySelectorAll('.otk-overflow-item:not([hidden]) [data-tab]')].map(e=>e.dataset.tab),pinned:[...strip.querySelectorAll('.otk-overflow-item[data-pinned=true] [data-tab]')].map(e=>e.dataset.tab)}})()`);
  const evidence: unknown[] = [];
  resources().evidence(
    "task overflow fixed geometry",
    () =>
      Deno.writeTextFile(
        join(root, "task-overflow.json"),
        JSON.stringify(evidence, null, 2),
      ),
  );
  const size = async (width: number) => {
    await b.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.evaluate(
      "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
    );
  };
  for (const theme of ["otk-dark", "otk-light"]) {
    await c.rpc("prefs.set", { key: "theme", value: theme });
    await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
    for (const width of [600, 800, 1280, 1920]) {
      await size(width);
      const g = await geometry();
      evidence.push({ theme, width, idle: g });
      assert(Math.abs(g.height - g.expected) <= 1, JSON.stringify(g));
      assertEquals(
        await b.evaluate(
          "document.querySelectorAll('.otk-task-list .otk-overflow-more').length",
        ),
        1,
      );
    }
  }
  await size(800);
  f.update(ids[242], { status: "busy" });
  await b.poll(
    `!!document.querySelector('[data-tab="${
      tasks[242]
    }"] .otk-status-light[data-state=working]')`,
  );
  f.update(ids[242], { status: "idle" });
  f.update(ids[241], {
    attention: { ...f.entries[0].attention, permissions: 1 },
  });
  f.update(ids[240], { status: "busy" });
  for (let n = 200; n < 220; n++) f.update(ids[n], { status: "busy" });
  await b.goto(`${f.url}/#/local/${ids[250]}`);
  for (const theme of ["otk-dark", "otk-light"]) {
    await c.rpc("prefs.set", { key: "theme", value: theme });
    await b.poll(
      `document.documentElement.dataset.otkTheme==='${theme}'&&document.querySelector('.otk-task-list .otk-overflow-row')?.classList.contains('wraps-required')`,
    );
    await b.evaluate("document.fonts.ready");
    const g = await geometry();
    evidence.push({ theme, width: 800, wrapped: g });
    assert(g.height > g.expected);
    assertEquals(g.visible.slice().sort(), g.pinned.slice().sort());
    assert(
      await b.evaluate(
        `${
          JSON.stringify([
            ...tasks.slice(200, 220),
            tasks[240],
            tasks[241],
            tasks[242],
            tasks[250],
          ])
        }.every(id=>{const e=document.querySelector('[data-tab="'+id+'"]'),r=e?.getBoundingClientRect();return !!r&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight&&!e.closest('[hidden]')})`,
      ),
    );
  }
  assertEquals(b.errors, []);
  await resources().capture();
  await c.close();
  await b.close();
  await f.app.stop();
});
