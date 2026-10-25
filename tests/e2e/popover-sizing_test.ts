// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Cdp } from "../support/cdp.ts";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";

const context = ':popover-open [role="menu"][aria-label="Context menu"]';
interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}
interface Geometry {
  surface: Rect;
  panel: Rect;
  anchor?: Rect;
  body: { height: number; scroll: number };
  viewport: { width: number; height: number };
  rows: { visible: boolean; hit: boolean }[];
}
async function geometry(
  browser: Cdp,
  selector: string,
  anchor?: string,
): Promise<Geometry> {
  await browser.poll(
    `(()=>{const el=document.querySelector(${
      JSON.stringify(selector)
    }),p=el?.closest('.otk-popover-panel');return p?.matches(':popover-open')&&document.querySelector('.otk-popover[data-open=true]')})()`,
  );
  await browser.evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  return await browser.evaluate<Geometry>(`(()=>{
    const el=document.querySelector(${
    JSON.stringify(selector)
  }),surface=el.closest('.otk-surface'),panel=surface.closest('.otk-popover-panel'),body=surface.querySelector('.otk-surface-body'),r=surface.getBoundingClientRect(),clip=body.getBoundingClientRect();
    return {surface:r.toJSON(),panel:panel.getBoundingClientRect().toJSON(),anchor:${
    anchor
      ? `document.querySelector(${
        JSON.stringify(anchor)
      }).getBoundingClientRect().toJSON()`
      : "undefined"
  },body:{height:body.clientHeight,scroll:body.scrollHeight},viewport:{width:innerWidth,height:innerHeight},rows:[...el.querySelectorAll('[role=menuitem]')].map(row=>{const t=row.getBoundingClientRect(),hit=document.elementFromPoint(t.x+t.width/2,t.y+t.height/2);return {visible:t.width>0&&t.height>0&&t.left>=r.left&&t.right<=r.right&&t.top>=clip.top&&t.bottom<=clip.bottom,hit:!!hit&&row.contains(hit)}})};
  })()`);
}
function contained(g: Geometry, label: string): void {
  const r = g.surface;
  assert(
    r.width > 0 && r.height > 0 && g.body.height > 0,
    `${label}: empty painted Surface ${JSON.stringify(g)}`,
  );
  assert(
    r.left >= -.5 && r.top >= -.5 && r.right <= g.viewport.width + .5 &&
      r.bottom <= g.viewport.height + .5,
    `${label}: Surface outside viewport ${JSON.stringify(g)}`,
  );
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    assert(
      Math.abs(r[edge] - g.panel[edge]) <= .5,
      `${label}: positioned box disagrees with painted Surface ${
        JSON.stringify(g)
      }`,
    );
  }
  if (g.anchor) {
    const a = g.anchor;
    assert(
      r.bottom <= a.top + .5 || r.top >= a.bottom - .5 ||
        r.right <= a.left + .5 || r.left >= a.right - .5,
      `${label}: Surface overlaps its anchor ${JSON.stringify(g)}`,
    );
  }
}
async function close(browser: Cdp): Promise<void> {
  await browser.key("Escape");
  await browser.poll("!document.querySelector(':popover-open')");
}
async function keyboardContext(browser: Cdp): Promise<void> {
  await browser.key("ContextMenu");
  await browser.poll(
    `document.querySelector('.otk-context-menu')?.dataset.open==='true'&&document.activeElement?.matches('${context} [role=menuitem]')`,
  );
}

for (const theme of ["otk-dark", "otk-light"]) {
  test(`native body fallback and point/rect corners size to hit-testable painted Surface in ${theme}`, async () => {
    const root = await fixture(),
      f = await inboxBrowserFixture(root),
      browser = await Cdp.launch(root),
      client = new WsClient(f.url);
    try {
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.goto(f.url);
      await openSession(browser, "otk");
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      await browser.evaluate("document.fonts.ready.then(()=>true)");
      // Reusing a bottom-anchored menu exposes the empty-side shrink; a fresh
      // first invocation alone can accidentally choose the useful fallback.
      await browser.evaluate(
        "document.querySelector('.otk-keys-entry').focus()",
      );
      await keyboardContext(browser);
      contained(await geometry(browser, context), "initial footer menu");
      await close(browser);
      await browser.evaluate("document.activeElement.blur()");
      await keyboardContext(browser);
      const body = await geometry(browser, context);
      const captures = Deno.env.get("OTK_A9_SCREENSHOTS_DIR");
      if (captures) {
        await browser.screenshot(join(captures, `body-fallback-${theme}.png`));
      }
      contained(body, "body fallback");
      assert(
        body.rows.length > 0 &&
          body.rows.every((row) => row.visible && row.hit),
        `Body menu rows are clipped or not hit-testable: ${
          JSON.stringify(body)
        }`,
      );
      const before = f.entries.length;
      await browser.key("Enter");
      await browser.poll(
        `document.querySelector('.otk-session-crumb[aria-current] .otk-crumb-title')?.textContent==='New session'`,
      );
      assertEquals(
        f.entries.length,
        before + 1,
        "The visible first body-fallback action must reach session creation",
      );

      const viewport = await browser.evaluate<
        { width: number; height: number }
      >("({width:innerWidth,height:innerHeight})");
      for (
        const [x, y] of [[1, 1], [viewport.width - 1, 1], [
          1,
          viewport.height - 1,
        ], [viewport.width - 1, viewport.height - 1]]
      ) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await browser.send("Input.dispatchMouseEvent", {
            type,
            x,
            y,
            button: "right",
            buttons: type === "mousePressed" ? 2 : 0,
            clickCount: 1,
          });
        }
        await browser.poll(
          `document.querySelector('.otk-context-menu')?.dataset.open==='true'&&document.activeElement===document.querySelector('${context}')`,
        );
        const point = await geometry(browser, context);
        contained(point, `point ${x},${y}`);
        assert(
          point.rows.length > 0 &&
            point.rows.every((row) => row.visible && row.hit),
          JSON.stringify(point),
        );
        await close(browser);
      }
      for (
        const edges of [
          "left:0;top:0",
          "right:0;top:0",
          "left:0;bottom:0",
          "right:0;bottom:0",
        ]
      ) {
        await browser.evaluate(
          `(()=>{const el=document.querySelector('.otk-tabs-project');el.tabIndex=0;el.style.cssText='position:fixed;width:160px;height:40px;'+${
            JSON.stringify(edges)
          };el.focus()})()`,
        );
        await keyboardContext(browser);
        const rect = await geometry(browser, context, ".otk-tabs-project");
        contained(rect, `rect ${edges}`);
        assert(
          rect.rows.length > 0 &&
            rect.rows.every((row) => row.visible && row.hit),
          JSON.stringify(rect),
        );
        await close(browser);
      }
      assertEquals(browser.errors, []);
    } finally {
      await client.close();
      await browser.close();
      await f.app.stop();
    }
  });
}

test("tall anchored Surface keeps its positioned bounds and scrolls within the available native side", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    browser = await Cdp.launch(root),
    client = new WsClient(f.url);
  try {
    await client.connect();
    await browser.goto(f.url);
    await openSession(browser, "otk");
    await browser.evaluate("document.fonts.ready.then(()=>true)");
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      for (const [width, height] of [[1280, 657], [720, 360]]) {
        await browser.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        // Reuse a previously side-clipped owner at both viewport edges too.
        // Preserve anchor-name: replacing cssText would erase the real anchor.
        for (
          const position of [
            { top: "50%", bottom: "auto" },
            { top: "0", bottom: "auto" },
            { top: "auto", bottom: "0" },
          ]
        ) {
          await browser.evaluate(
            `(()=>{const el=document.querySelector('.otk-display-menu > button');Object.assign(el.style,{position:'fixed',left:'50%',...${
              JSON.stringify(position)
            }});el.focus()})()`,
          );
          await browser.click(".otk-display-menu > button");
          const g = await geometry(
            browser,
            ".otk-display-menu :popover-open .otk-display-preferences",
            ".otk-display-menu > button",
          );
          contained(
            g,
            `tall ${theme} ${width}x${height} ${JSON.stringify(position)}`,
          );
          assert(
            g.body.scroll > g.body.height,
            `Tall content must scroll inside its Surface ${JSON.stringify(g)}`,
          );
          await browser.evaluate(
            "(()=>{const body=document.querySelector('.otk-display-menu :popover-open .otk-surface-body');body.scrollTop=body.scrollHeight})()",
          );
          assert(
            await browser.evaluate(
              "(()=>{const input=document.querySelector('.otk-display-menu :popover-open input[name=animationsOff]'),r=input.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(hit===input||input.contains(hit))})()",
            ),
            "Last control must be hit-testable after internal scrolling",
          );
          await close(browser);
        }
      }
    }
    assertEquals(browser.errors, []);
  } finally {
    await client.close();
    await browser.close();
    await f.app.stop();
  }
});
