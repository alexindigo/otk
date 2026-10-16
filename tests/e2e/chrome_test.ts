// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { TaskRecord } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("quiet chrome keeps corner geometry and non-colour selection across themes, collapse states and reload", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    const base = f.entries[0];
    f.add({
      ...base,
      id: "child",
      parentID: base.id,
      title: "Explore callers",
    });
    f.add({
      ...base,
      id: "blocked",
      title: "Approve schema",
      attention: { ...base.attention, questions: 1 },
    });
    f.update(base.id, { status: "busy" });
    await c.rpc<TaskRecord>("tasks.create", {
      directory: base.directory,
      name: "Execution",
      sessions: [base.id],
    });
    await c.rpc("layout.patch", { rightCollapsed: false });
    await b.goto(f.url + "/#/local/otk/child");
    await b.poll(
      "!!document.querySelector('.otk-session-crumb[aria-current]') && !!document.querySelector('[data-session=child][aria-current]')",
    );
    let corners: number[][] | undefined;
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (const reduced of [false, true]) {
        await c.rpc("prefs.set", { key: "reducedColors", value: reduced });
        await b.poll(
          `document.documentElement.hasAttribute('data-otk-reduced-colors')===${reduced}`,
        );
        for (const leftCollapsed of [false, true]) {
          for (const rightCollapsed of [false, true]) {
            await c.rpc("layout.patch", { leftCollapsed, rightCollapsed });
            await b.poll(
              `document.querySelector('.otk-project-inbox').dataset.collapsed==='${leftCollapsed}' && document.querySelector('.otk-right-panel').hidden===${rightCollapsed}`,
            );
            const actual = await b.evaluate<number[][]>(
              `['.otk-corner-left','.otk-corner-right'].map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!e.contains(hit))throw Error('Covered corner '+s);return [r.x,r.y,r.width,r.height]})`,
            );
            corners ??= actual;
            actual.forEach((rect, i) =>
              rect.forEach((value, j) =>
                assert(
                  Math.abs(value - corners![i][j]) <= .5,
                  JSON.stringify({
                    theme,
                    leftCollapsed,
                    rightCollapsed,
                    actual,
                    corners,
                  }),
                )
              )
            );
            const indicators = await b.evaluate<
              {
                orientation: string;
                w: number;
                h: number;
                centred: number;
                fill: string;
              }[]
            >(`[...document.querySelectorAll('[data-otk-selection][aria-current], [data-otk-selection][aria-selected=true]')].filter(e=>e.getBoundingClientRect().width).map(e=>{const s=getComputedStyle(e,'::after'),r=e.getBoundingClientRect();return {orientation:e.dataset.otkSelection,w:parseFloat(s.width),h:parseFloat(s.height),centred:Math.abs(parseFloat(s.top)+parseFloat(s.marginTop)+parseFloat(s.height)/2-r.height/2),fill:getComputedStyle(e).backgroundColor}})`);
            assert(indicators.length >= (rightCollapsed ? 3 : 5));
            for (const item of indicators) {
              assert(item.fill !== "rgba(0, 0, 0, 0)");
              if (item.orientation === "vertical") {
                assertEquals(item.w, 3);
                assertEquals(item.h, 14);
                assert(item.centred <= .5, JSON.stringify(item));
              } else {
                assertEquals(item.h, 2);
                assert(item.w > 0);
              }
            }
            assertEquals(
              await b.evaluate(
                `!!document.querySelector('.otk-session-view .otk-view-header') || !!document.querySelector('.otk-shell-toolbar') || [...document.querySelectorAll('.otk-project-inbox,.otk-project-tabs,.otk-right-panel')].some(e=>/Ctrl[+ ]|Enter to send|j\\/k select|Agent service connected/.test(e.innerText))`,
              ),
              false,
            );
            assertEquals(
              await b.evaluate(
                `(()=>{let opacity=1;for(let e=document.querySelector('[data-tab=blocked] .otk-lamp-body');e;e=e.parentElement)opacity*=Number(getComputedStyle(e).opacity);return opacity})()`,
              ),
              1,
              "Phantom lamps retain full paint",
            );
          }
        }
      }
    }
    // The actual corner buttons, not only RPC-driven geometry, change persisted layout.
    await b.click(".otk-corner-left");
    await b.poll(
      "document.querySelector('.otk-project-inbox').dataset.collapsed==='false'",
    );
    await b.click(".otk-corner-right");
    await b.poll("!document.querySelector('.otk-right-panel').hidden");
    await b.reload();
    await b.poll(
      "document.querySelector('.otk-project-inbox')?.dataset.collapsed==='false' && !document.querySelector('.otk-right-panel').hidden && !!document.querySelector('[data-session=child][aria-current]')",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-task-strip').getBoundingClientRect().height",
      ),
      52,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-project-row').getBoundingClientRect().height",
      ),
      32,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-session-row').getBoundingClientRect().height",
      ),
      30,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-session-branch').textContent",
      ),
      "",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-session-crumb[aria-current]').title",
      ),
      base.directory,
    );
    const grab = await b.evaluate<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector('.otk-inbox-resizer').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    await b.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...grab,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await b.poll(
      "document.querySelector('.otk-inbox-resizer').hasPointerCapture(1)",
    );
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: grab.x + 64,
      y: grab.y,
      button: "left",
      buttons: 1,
    });
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: grab.x + 64,
      y: grab.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await b.poll(
      "document.querySelector('.otk-project-inbox').getBoundingClientRect().width===312",
    );
    await b.reload();
    await b.poll(
      "document.querySelector('.otk-project-inbox')?.getBoundingClientRect().width===312 && !!document.querySelector('[data-session=child][aria-current]')",
    );
    const hover = await b.evaluate<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector('[data-project-sessions~=atmosphera]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...hover });
    await b.poll(
      `(()=>{const row=document.querySelector('[data-project-sessions~=atmosphera]');return getComputedStyle(row.querySelector('.otk-project-menu')).opacity==='1' && getComputedStyle(row.querySelector('time')).opacity==='0'})()`,
    );
    assertEquals(
      await b.evaluate(
        `getComputedStyle(document.querySelector('[data-project-sessions~=atmosphera] .otk-project-open'),'::after').content`,
      ),
      "none",
      "Hover alone must not claim selection",
    );
    await b.click(".otk-inbox-search");
    await b.poll("!!document.querySelector('input[name=command-search]')");
    await b.fill("input[name=command-search]", "Choose theme");
    await b.poll(
      "document.querySelectorAll('.otk-palette-list button').length===1",
    );
    assertEquals(
      await b.evaluate(
        `getComputedStyle(document.querySelector('.otk-palette-list [data-selected]'),'::after').width`,
      ),
      "3px",
    );
    await b.key("Enter");
    await b.poll(
      "!!document.querySelector('[data-theme-choice=otk-light-stone][aria-pressed=true]')",
    );
    assertEquals(
      await b.evaluate(
        `getComputedStyle(document.querySelector('[data-theme-choice][aria-pressed=true]'),'::after').height`,
      ),
      "14px",
    );
    await b.key("Escape");
    await b.poll(
      "!document.querySelector('dialog') && document.documentElement.dataset.otkTheme==='otk-light-stone'",
    );
    assertEquals(b.errors, []);
  } finally {
    await c.close();
    await b.close();
    await f.app.stop();
  }
});
