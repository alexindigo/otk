// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
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
