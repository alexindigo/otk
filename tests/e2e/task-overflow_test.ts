// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";
import { resources, test } from "../support/resources.ts";
import { menuReady } from "../support/menu.ts";

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
    const task = await c.rpc<{ id: string }>("tasks.create", {
      directory,
      name: `Qualification task ${n}`,
      sessions: [id],
    });
    tasks.push(task.id);
  }
  await c.rpc("layout.patch", { leftCollapsed: true, rightCollapsed: true });
  await b.goto(`${f.url}/#/local/${ids[0]}`);
  await b.poll(
    "!!document.querySelector('textarea[name=prompt]') && !!document.querySelector('.otk-task-list [data-tab]')",
  );
  const visible = (n: number) =>
    b.evaluate<boolean>(
      `(()=>{const e=document.querySelector('[data-tab="${
        tasks[n]
      }"]'),r=e?.getBoundingClientRect();return !!r&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight&&!e.closest('[hidden]')})()`,
    );
  const geometry = () =>
    b.evaluate<
      { height: number; expected: number; visible: string[]; pinned: string[] }
    >(`(()=>{const strip=document.querySelector('.otk-task-strip'),row=strip.querySelector('.otk-overflow-row');return {height:strip.getBoundingClientRect().height,expected:parseFloat(getComputedStyle(strip).getPropertyValue('--chrome-header-height')),visible:[...strip.querySelectorAll('.otk-overflow-item:not([hidden]) [data-tab]')].map(e=>e.dataset.tab),pinned:[...strip.querySelectorAll('.otk-overflow-item[data-pinned=true] [data-tab]')].map(e=>e.dataset.tab)}})()`);
  const evidence: unknown[] = [];
  resources().evidence("task overflow geometry", async () => {
    await Deno.writeTextFile(
      join(root, "task-overflow.json"),
      JSON.stringify(evidence, null, 2),
    );
    await Deno.writeTextFile(
      join(root, "task-overflow.html"),
      await b.evaluate<string>("document.documentElement.outerHTML"),
    );
  });
  for (const theme of ["otk-dark", "otk-light"]) {
    await c.rpc("prefs.set", { key: "theme", value: theme });
    await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
    for (const width of [600, 800, 1280, 1920]) {
      await b.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await b.evaluate(
        "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
      );
      const g = await geometry();
      evidence.push({ theme, width, idle: g });
      assert(Math.abs(g.height - g.expected) <= 1, JSON.stringify(g));
      assert(await visible(0));
      assertEquals(
        await b.evaluate(
          "document.querySelectorAll('.otk-task-list .otk-overflow-more').length",
        ),
        1,
      );
    }
  }
  await b.send("Emulation.setDeviceMetricsOverride", {
    width: 800,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await b.click('.otk-task-list [aria-label="More tasks"]');
  const menu = ".otk-folded-tasks :popover-open [role=menu]";
  await menuReady(b, menu, ".otk-folded-tasks");
  await b.click(`${menu} [data-overflow-tab="${tasks[250]}"]`);
  await b.poll(
    `document.querySelector('[data-tab="${
      tasks[250]
    }"]')?.getAttribute('aria-selected')==='true' && location.hash.endsWith('/${
      ids[250]
    }')`,
  );
  assert(await visible(250));
  f.update(ids[240], { status: "busy" });
  f.update(ids[241], {
    attention: { ...f.entries[0].attention, permissions: 1 },
  });
  f.update(ids[242], { status: "busy" });
  await b.poll(
    `!!document.querySelector('[data-tab="${
      tasks[242]
    }"] .otk-status-light[data-state=working]')`,
  );
  f.update(ids[242], { status: "idle" });
  await b.poll(
    `!!document.querySelector('[data-tab="${
      tasks[240]
    }"] .otk-status-light[data-state=working]') && !!document.querySelector('[data-tab="${
      tasks[241]
    }"] .otk-status-light[data-state=blocked]') && !!document.querySelector('[data-tab="${
      tasks[242]
    }"] .otk-status-light[data-state=finished]')`,
  );
  for (const n of [240, 241, 242, 250]) assert(await visible(n));
  for (let n = 200; n < 220; n++) f.update(ids[n], { status: "busy" });
  await b.poll(
    `document.querySelector('.otk-task-list .otk-overflow-row')?.classList.contains('wraps-required') && ${
      JSON.stringify(tasks.slice(200, 220))
    }.every(id=>{const e=document.querySelector('[data-tab="'+id+'"]'),r=e?.getBoundingClientRect();return !!r&&r.width>0&&r.height>0&&!e.closest('[hidden]')&&!!e.querySelector('.otk-status-light[data-state=working]')})`,
  );
  const wrapped = await geometry();
  evidence.push({ wrapped });
  assert(wrapped.height > wrapped.expected);
  assertEquals(
    wrapped.visible.slice().sort(),
    wrapped.pinned.slice().sort(),
    "Only required tasks occupy wrapped lines",
  );
  for (
    const n of [
      ...Array.from({ length: 20 }, (_, n) => n + 200),
      240,
      241,
      242,
      250,
    ]
  ) assert(await visible(n));
  await b.click('.otk-task-list [aria-label="More tasks"]');
  await menuReady(b, menu, ".otk-folded-tasks");
  for (const id of wrapped.pinned) {
    assertEquals(
      await b.evaluate(
        `!!document.querySelector('${menu} [data-overflow-tab="${id}"]')`,
      ),
      false,
    );
  }
  await b.key("Escape");
  const shots = Deno.env.get("OTK_REMAINING_SHOTS");
  for (const theme of ["otk-dark", "otk-light"]) {
    await c.rpc("prefs.set", { key: "theme", value: theme });
    await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
    if (shots) {
      await Deno.mkdir(shots, { recursive: true });
      await b.screenshot(join(shots, `task-pins-${theme}.png`));
    }
  }
  assertEquals(b.errors, []);
  await resources().capture();
  await c.close();
  await b.close();
  await f.app.stop();
});
