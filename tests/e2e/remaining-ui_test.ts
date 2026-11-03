// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import type { TaskRecord } from "@otk/protocol";
import { menuReady } from "../support/menu.ts";
import { accessoryGeometry } from "../support/control-geometry.ts";

async function shot(b: Cdp, name: string) {
  const dir = Deno.env.get("OTK_REMAINING_SHOTS");
  if (!dir) return;
  await Deno.mkdir(dir, { recursive: true });
  await b.evaluate(
    "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
  );
  await b.screenshot(join(dir, `${name}.png`));
}

test("remaining UI: form fills its dialog and uses the primary action", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    await b.goto(f.url);
    await openSession(b, "tstv1-otk");
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await b.click(".otk-task-new");
      await b.poll(
        "!!document.querySelector('dialog[open] input[name=taskName]')",
      );
      for (const zoom of [1, 2]) {
        for (const physicalWidth of [600, 800, 1280, 1920]) {
          await b.send("Emulation.setDeviceMetricsOverride", {
            width: physicalWidth / zoom,
            height: 1000 / zoom,
            deviceScaleFactor: zoom,
            mobile: false,
          });
          const geometry = await b.evaluate<
            { delta: number; primary: boolean; width: number }
          >(`(() => {
        const field=document.querySelector('dialog[open] input[name=taskName]'), form=field.closest('form'), body=form.closest('.otk-surface-body'), button=form.querySelector('button[type=submit]');
        const r=field.getBoundingClientRect(), f=form.getBoundingClientRect(), b=body.getBoundingClientRect(), s=getComputedStyle(body), p=getComputedStyle(button);
        const probe=document.createElement('span');probe.style.color='var(--otk-action-on)';probe.style.background='var(--otk-action)';document.body.append(probe);const expected=getComputedStyle(probe); const primary=p.backgroundColor===expected.backgroundColor&&p.color===expected.color;probe.remove();
        return {delta:Math.max(Math.abs(r.left-b.left-parseFloat(s.paddingLeft)),Math.abs(r.right-b.right+parseFloat(s.paddingRight)),Math.abs(f.width-r.width)), primary, width:document.querySelector('dialog[open]').getBoundingClientRect().width};
      })()`);
          assert(geometry.delta <= 1, JSON.stringify(geometry));
          assert(geometry.primary, "Form action must use theme primary paint");
          assert(geometry.width <= 32 * 13 + 1, "Dialog owns form width role");
        }
      }
      await b.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await shot(b, `task-idle-${theme}`);
      // C13 owns submission and the terminal task inventory; keep fixed form paint.
      await b.key("Escape");
      await b.poll("!document.querySelector('dialog[open]')");
    }
    assertEquals(b.errors, []);
  } finally {
    await c.close();
    await b.close();
    await f.app.stop();
  }
});

test("remaining UI: measured breadcrumbs preserve selected identity without wrapping", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    const ids = ["tstv1-otk"];
    for (let i = 1; i < 12; i++) {
      const id = `tstv1-geometry-${i}`;
      ids.push(id);
      f.add({
        ...f.entries[0],
        id,
        title: `Session ${i} with a deliberately long name`,
      });
    }
    const task = await c.rpc<TaskRecord>("tasks.create", {
      directory: f.entries[0].directory,
      name: "Geometry task",
      sessions: ids,
    });
    await c.rpc("prefs.set", {
      key: "shellLayout",
      value: {
        ...(await c.rpc<import("@otk/protocol").Preferences>("prefs.get", {}))
          .shellLayout,
        leftCollapsed: true,
        rightCollapsed: true,
      },
    });
    await b.goto(f.url);
    await openSession(b, ids[5]);
    await c.rpc("prefs.set", {
      key: "shellLayout",
      value: {
        ...(await c.rpc<import("@otk/protocol").Preferences>("prefs.get", {}))
          .shellLayout,
        leftCollapsed: true,
        rightCollapsed: true,
      },
    });
    await b.poll("document.querySelector('.otk-right-panel').hidden");
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      for (const zoom of [1, 2]) {
        for (const physicalWidth of [600, 800, 1280, 1920]) {
          const width = physicalWidth / zoom;
          await b.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 800 / zoom,
            deviceScaleFactor: zoom,
            mobile: false,
          });
          await b.evaluate(
            "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
          );
          const result = await b.evaluate<
            {
              height: number;
              centres: number[];
              overlap: boolean;
              selected: boolean;
              menus: number;
            }
          >(`(()=>{const row=document.querySelector('.otk-breadcrumb-row'),r=row.getBoundingClientRect(), chips=[...row.querySelectorAll('[data-crumb]')].filter(e=>e.getBoundingClientRect().width&&getComputedStyle(e).visibility!=='hidden'),meter=row.querySelector('output').getBoundingClientRect();return {height:r.height,centres:chips.map(e=>{const b=e.getBoundingClientRect();return b.y+b.height/2}),overlap:chips.some(e=>e.getBoundingClientRect().right>meter.left),selected:chips.some(e=>e.dataset.crumb==='${
            ids[5]
          }'),menus:row.querySelectorAll('.otk-folded-crumbs').length}})()`);
          assert(result.height <= 32, JSON.stringify({ width, result }));
          assert(
            result.selected && !result.overlap,
            JSON.stringify({ width, result }),
          );
          assert(
            Math.max(...result.centres) - Math.min(...result.centres) <= 1,
            JSON.stringify(result),
          );
          assert(result.menus <= 1);
          assertEquals(
            await b.evaluate(
              `(()=>{const lane=document.querySelector('.otk-overflow-row'),s=lane.getBoundingClientRect(),more=lane.querySelector('.otk-folded-crumbs')?.getBoundingClientRect(),action=document.querySelector('.otk-new-session').getBoundingClientRect(),meter=document.querySelector('.otk-context-meter').getBoundingClientRect();return [...lane.querySelectorAll('[data-crumb]')].every(e=>{const r=e.getBoundingClientRect(),label=e.querySelector('.otk-crumb-title'),range=document.createRange();range.selectNodeContents(label);return r.right<=(more?.left??s.right)+1&&r.right<=action.left+1&&r.right<=meter.left+1&&range.getBoundingClientRect().height<=parseFloat(getComputedStyle(label).lineHeight)+1})})()`,
            ),
            true,
          );
          if (physicalWidth === 800 && zoom === 1) {
            await shot(b, `overflow-${theme}`);
          }
        }
      }
      await b.send("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await b.click(".otk-folded-crumbs > button");
      await b.poll(
        "!!document.querySelector('.otk-folded-crumbs :popover-open')",
      );
      await menuReady(
        b,
        ".otk-folded-crumbs [role=menu]",
        ".otk-folded-crumbs",
      );
      const hidden = await b.evaluate<string[]>(
        "[...document.querySelectorAll('.otk-folded-crumbs [role=menuitem]')].map(e=>e.textContent)",
      );
      const visible = await b.evaluate<string[]>(
        "[...document.querySelectorAll('[data-crumb]')].filter(e=>!e.closest('[hidden]')).map(e=>e.dataset.crumb)",
      );
      assertEquals(
        visible.length + hidden.length,
        ids.length,
        "One exact partition",
      );
      // Navigation and captured title identity run once in C13's Node contract.
      await b.key("Escape");
    }
    assert(task.id);
    assertEquals(b.errors, []);
  } finally {
    await c.close();
    await b.close();
    await f.app.stop();
  }
});

test("remaining UI: empty content is centred in the pane remaining below chrome", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    const task = await c.rpc<TaskRecord>("tasks.create", {
      directory: f.entries[0].directory,
      name: "Empty task",
    });
    await b.goto(f.url);
    await openSession(b, "tstv1-otk");
    await b.click(`[data-tab="${task.id}"]`);
    await b.poll("!!document.querySelector('.otk-welcome h1')");
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      for (const zoom of [1, 2]) {
        for (const physicalWidth of [600, 800, 1280, 1920]) {
          const width = physicalWidth / zoom;
          await b.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 800 / zoom,
            deviceScaleFactor: zoom,
            mobile: false,
          });
          for (const collapsed of [true, false]) {
            if (width < 1280 && !collapsed) {
              continue;
            }
            await c.rpc("prefs.set", {
              key: "shellLayout",
              value: {
                ...(await c.rpc<import("@otk/protocol").Preferences>(
                  "prefs.get",
                  {},
                )).shellLayout,
                leftCollapsed: collapsed,
                rightCollapsed: collapsed,
              },
            });
            await b.evaluate(
              "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
            );
            const g = await b.evaluate<number[]>(
              "(()=>{const pane=document.querySelector('.otk-welcome').getBoundingClientRect(),owner=document.querySelector('.otk-pane-state-content');let group;if(owner)group=owner.getBoundingClientRect();else {const range=document.createRange();range.setStartBefore(document.querySelector('.otk-welcome h1'));range.setEndAfter(document.querySelector('.otk-welcome p'));group=range.getBoundingClientRect();}return [Math.abs((pane.left+pane.right-group.left-group.right)/2),Math.abs((pane.top+pane.bottom-group.top-group.bottom)/2)]})()",
            );
            assert(
              g.every((delta) => delta <= 1),
              JSON.stringify({ width, collapsed, g }),
            );
          }
          if (width === 1280 && zoom === 1) await shot(b, `empty-${theme}`);
        }
      }
    }
    await b.reload();
    await b.poll("!!document.querySelector('.otk-welcome')");
    assertEquals(b.errors, []);
  } finally {
    await c.close();
    await b.close();
    await f.app.stop();
  }
});

test("remaining UI: every composer and native preference select shares its accessory geometry", async () => {
  const f = await browserFixture();
  let c: WsClient | undefined;
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Shared picker slots" },
      }),
      server = await f.sidecar();
    c = new WsClient(server.url);
    await c.connect();
    const b = await f.browser(server.url);
    await openSession(b, session.id);
    await b.poll("document.querySelectorAll('.otk-control-trigger').length>=2");
    await b.poll(
      "document.querySelector('.otk-messages p.otk-muted')?.textContent==='Start a conversation below.'",
    );
    const empty = await b.evaluate<number[]>(
      "(()=>{const pane=document.querySelector('.otk-messages').getBoundingClientRect(),range=document.createRange();range.selectNodeContents(document.querySelector('.otk-messages p.otk-muted'));const group=range.getBoundingClientRect();return [Math.abs((pane.left+pane.right-group.left-group.right)/2),Math.abs((pane.top+pane.bottom-group.top-group.bottom)/2)]})()",
    );
    assert(
      empty.every((delta) => delta <= 1),
      JSON.stringify({ selectedEmpty: empty }),
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      for (const width of [600, 800, 1280, 1920]) {
        await b.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await b.evaluate(
          "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
        );
        for (const state of ["normal", "focus", "hover"]) {
          if (state === "focus") {
            await b.evaluate(
              "document.querySelector('.otk-control-trigger').focus()",
            );
          }
          if (state === "hover") {
            const p = await b.evaluate<{ x: number; y: number }>(
              "(()=>{const r=document.querySelector('.otk-control-trigger').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
            );
            await b.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...p,
            });
          }
          const values = await b.evaluate<
            { label: string; icon: number[]; gaps: number[] }[]
          >(accessoryGeometry);
          assert(values.length >= 2);
          for (const value of values) {
            assertEquals(value.icon, [16, 16]);
            assert(
              Math.max(...value.gaps) - Math.min(...value.gaps) <= 1,
              JSON.stringify({ width, state, value }),
            );
          }
        }
      }
      await b.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await shot(b, `pickers-${theme}`);
      await b.click(".otk-display-menu > button");
      await b.poll(
        "!!document.querySelector('.otk-display-menu :popover-open select')",
      );
      const values = await b.evaluate<
        { label: string; icon: number[]; gaps: number[] }[]
      >(accessoryGeometry);
      assert(values.some((value) => value.label === "diffStyle"));
      for (const value of values) {
        assert(
          Math.max(...value.gaps) - Math.min(...value.gaps) <= 1,
          JSON.stringify(value),
        );
      }
      await shot(b, `preferences-${theme}`);
      await b.key("Escape");
      await b.click('[aria-label="Edit prompt"]');
      await b.poll(
        "!!document.querySelector('dialog[open] textarea[name=editor]')",
      );
      for (const zoom of [1, 2]) {
        for (const physicalWidth of [600, 800, 1280, 1920]) {
          await b.send("Emulation.setDeviceMetricsOverride", {
            width: physicalWidth / zoom,
            height: 1000 / zoom,
            deviceScaleFactor: zoom,
            mobile: false,
          });
          await b.evaluate(
            "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
          );
          const bounds = await b.evaluate<number[]>(
            "(()=>{const d=document.querySelector('dialog[open]').getBoundingClientRect(),t=document.querySelector('textarea[name=editor]').getBoundingClientRect(),f=document.querySelector('.otk-editor footer').getBoundingClientRect(),g=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--overlay-gutter'));return [d.left-g,innerWidth-d.right-g,d.top-g,innerHeight-d.bottom-g,f.top-t.bottom,d.bottom-f.bottom]})()",
          );
          assert(
            bounds.slice(0, 5).every((value) => value >= -1),
            JSON.stringify({ physicalWidth, zoom, bounds }),
          );
          assert(bounds[5] < 24, JSON.stringify(bounds));
        }
      }
      await b.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await shot(b, `editor-${theme}`);
      await b.key("Escape");
      await b.click(".otk-settings-entry");
      await b.poll("!!document.querySelector('.otk-settings')");
      await shot(b, `settings-${theme}`);
      await b.click(".otk-settings .otk-view-header button");
      await b.poll("!document.querySelector('.otk-settings')");
    }
  } finally {
    await c?.close();
    await f.stop();
  }
});

test("remaining UI: native editor blur keeps More anchored and navigates its independent items", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        (await f.oc.session<{ id: string }>("/session", {
          method: "POST",
          body: { title: `Native ${i}` },
        })).id,
      );
    }
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("tasks.create", {
      directory: f.oc.directory,
      name: "Native folding",
      sessions: ids,
    });
    const b = await f.browser(server.url);
    await openSession(b, ids[4]);
    await client.rpc("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.rightClick(`[data-crumb="${ids[0]}"]`);
      await menuReady(b, ".otk-context-menu [role=menu]");
      await b.click(
        '.otk-context-menu [data-context-command="session.rename"]',
      );
      await b.poll(
        "document.activeElement?.matches('.otk-title-editor input')",
      );
      const moreBounds = () =>
        b.evaluate<number[]>(
          "(()=>{const r=document.querySelector('.otk-folded-crumbs > button').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()",
        );
      const before = await moreBounds();
      await b.click(".otk-folded-crumbs > button");
      await menuReady(
        b,
        ".otk-folded-crumbs [role=menu]",
        ".otk-folded-crumbs",
      );
      assert(
        (await moreBounds()).every((value, i) =>
          Math.abs(value - before[i]) <= 1
        ),
      );
      await b.key("ArrowDown");
      assert(
        await b.evaluate(
          "document.activeElement.matches('.otk-folded-crumbs [data-overflow-target]')",
        ),
      );
      assert(
        await b.evaluate(
          `document.querySelector('[data-crumb="${
            ids[4]
          }"]').getBoundingClientRect().width>0`,
        ),
      );
      const omitted = await b.evaluate<string[]>(
        "[...document.querySelectorAll('.otk-folded-crumbs [data-overflow-target]')].map(e=>e.dataset.overflowTarget)",
      );
      assert(omitted.length > 0);
      await shot(b, `native-more-${theme}`);
      await b.key("Escape");
    }
    assertEquals(b.errors, []);
  } finally {
    await client?.close();
    await f.stop();
  }
});
