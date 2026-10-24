// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

test("shared chrome geometry reaches both rails headers controls and corner reservations", async () => {
  const workspace = await fixture(), root = join(workspace, "chrome");
  await Deno.mkdir(root);
  const f = await coreBackendFixture(root, {
    prompt: { prompt: () => Promise.resolve(), abort: () => Promise.resolve() },
  });
  const b = await Cdp.launch(workspace), client = new WsClient(f.url);
  const errors: unknown[] = [];
  const shots = Deno.env.get("OTK_CHROME_SHOTS");
  const capture = async (name: string) => {
    if (!shots) return;
    await Deno.mkdir(shots, { recursive: true });
    await b.evaluate(
      "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
    );
    await b.screenshot(join(shots, `${name}.png`));
    await b.evaluate(
      "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
    );
    await b.screenshot(join(shots, `${name}-stable.png`));
    await Deno.writeTextFile(
      join(shots, `${name}.json`),
      JSON.stringify(
        await b.evaluate(
          "[...document.body.querySelectorAll('*')].filter(el=>!['STYLE','SCRIPT','LINK'].includes(el.tagName)).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,class:el.className,rect:[r.x,r.y,r.width,r.height],font:[s.fontFamily,s.fontSize,s.lineHeight,s.fontWeight],border:[s.borderRadius,s.borderWidth]}})",
        ),
      ),
    );
  };
  const layout = async (leftCollapsed: boolean, rightCollapsed: boolean) => {
    await client.rpc("layout.patch", { leftCollapsed, rightCollapsed });
    await b.poll(
      `document.querySelector('.otk-project-inbox')?.dataset.collapsed==='${leftCollapsed}' && !!document.querySelector('.otk-right-rail')===${rightCollapsed}`,
    );
  };
  const measure = () =>
    b.evaluate<Record<string, number>>(`(()=>{
    const rect=s=>document.querySelector(s).getBoundingClientRect();
    const css=(s,p)=>parseFloat(getComputedStyle(document.querySelector(s))[p]);
    const left=rect('.otk-corner-left'),right=rect('.otk-corner-right');
    return {leftRail:rect('.otk-project-inbox').width,rightRail:rect('.otk-right-rail').width,
      railHeader:rect('.otk-right-rail .otk-rail-header').height,brand:rect('.otk-inbox-brand').height,
      taskHeader:rect('.otk-task-strip').height,control:left.width,controlHeight:left.height,
      display:rect('.otk-display-trigger').width,server:rect('.otk-server-status').height,
      reserve:css('.otk-task-strip','paddingRight'),leftOffset:left.x,rightOffset:innerWidth-right.right};})()`);
  try {
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(`${f.url}/#/local/core`);
    await b.poll(
      "!!document.querySelector('.otk-prompt textarea') && !!document.querySelector('.otk-display-trigger')",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await layout(false, true);
      await capture(`${theme}-expanded`);
      await layout(true, true);
      await capture(`${theme}-rails`);
      const baseline = await measure();
      assertEquals(baseline, {
        leftRail: 48,
        rightRail: 48,
        railHeader: 52,
        brand: 52,
        taskHeader: 52,
        control: 28,
        controlHeight: 28,
        display: 28,
        server: 28,
        reserve: 48,
        leftOffset: 12,
        rightOffset: 12,
      });
      await b.evaluate(
        "(()=>{const s=document.documentElement.style;s.setProperty('--rail-width','64px');s.setProperty('--chrome-header-height','68px');s.setProperty('--control-size','36px')})()",
      );
      try {
        assertEquals(await measure(), {
          ...baseline,
          leftRail: 64,
          rightRail: 64,
          railHeader: 68,
          brand: 68,
          taskHeader: 68,
          control: 36,
          controlHeight: 36,
          display: 36,
          server: 36,
          reserve: 56,
        });
        await layout(false, false);
        assertEquals(
          await b.evaluate(
            "document.querySelector('.otk-panel-icons').getBoundingClientRect().height",
          ),
          68,
        );
        assertEquals(
          await b.evaluate(
            "parseFloat(getComputedStyle(document.querySelector('.otk-panel-icons')).paddingRight)",
          ),
          56,
        );
      } catch (error) {
        errors.push(error);
      } finally {
        await b.evaluate(
          "['--rail-width','--chrome-header-height','--control-size'].forEach(n=>document.documentElement.style.removeProperty(n))",
        );
      }
      await layout(false, false);
      await capture(`${theme}-open`);
      // ARIA, keyboard and pointer consume the same persisted width contract.
      for (
        const [selector, key, min, max, initial, direction] of [
          [".otk-inbox-resizer", "leftWidth", 200, 360, 248, 1],
          [".otk-panel-resizer", "rightWidth", 280, 480, 320, -1],
        ] as const
      ) {
        assertEquals(
          await b.evaluate(
            `(()=>{const e=document.querySelector('${selector}');return [Number(e.getAttribute('aria-valuemin')),Number(e.getAttribute('aria-valuemax'))]})()`,
          ),
          [min, max],
        );
        for (
          const [press, expected] of [["Home", min], ["End", max]] as const
        ) {
          await b.evaluate(`document.querySelector('${selector}').focus()`);
          await b.key(press);
          await b.poll(
            `Number(document.querySelector('${selector}').getAttribute('aria-valuenow'))===${expected}`,
          );
          assertEquals(
            (await client.rpc<{ shellLayout: Record<string, number> }>(
              "prefs.get",
              {},
            )).shellLayout[key],
            expected,
          );
        }
        await client.rpc("layout.patch", { [key]: initial });
        await b.poll(
          `Number(document.querySelector('${selector}').getAttribute('aria-valuenow'))===${initial}`,
        );
        const point = await b.evaluate<{ x: number; y: number }>(
          `(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+200}})()`,
        );
        await b.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...point,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        await b.poll(
          `document.querySelector('${selector}').hasPointerCapture(1)`,
        );
        await b.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x + direction * 500,
          y: point.y,
          button: "left",
          buttons: 1,
        });
        await b.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: point.x + direction * 500,
          y: point.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
        await b.poll(
          `Number(document.querySelector('${selector}').getAttribute('aria-valuenow'))===${max}`,
        );
        assertEquals(
          (await client.rpc<{ shellLayout: Record<string, number> }>(
            "prefs.get",
            {},
          )).shellLayout[key],
          max,
        );
        await client.rpc("layout.patch", { [key]: initial });
      }
      await layout(true, true);
      assertEquals(await measure(), baseline);
      assert(
        await b.evaluate(
          "[...document.querySelectorAll('.otk-corner')].every(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})",
        ),
      );
    }
    assertEquals(b.errors, []);
    if (errors.length) {
      throw new AggregateError(
        errors,
        "Chrome consumers bypass shared geometry",
      );
    }
  } finally {
    await b.close();
    await client.close();
    await f.app.stop();
  }
});
