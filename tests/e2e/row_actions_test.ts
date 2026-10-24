// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";

test("project time and menu share a stable flowing cell on hover and focus; no tab has a menu", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  const row = "[data-project-sessions~=otk]";
  const geometry =
    `(()=>{const row=document.querySelector('${row}'),cell=row.querySelector('.otk-project-trailing'),time=cell.querySelector('time'),trigger=cell.querySelector('.otk-popover-trigger'),r=cell.getBoundingClientRect(),t=time.getBoundingClientRect(),m=trigger.getBoundingClientRect();return {box:[r.x,r.y,r.width,r.height],row:row.getBoundingClientRect().toJSON(),centre:Math.max(Math.abs(t.y+t.height/2-m.y-m.height/2),Math.abs(m.y+m.height/2-r.y-r.height/2)),positions:[row,cell,time,trigger,...cell.children].map(e=>getComputedStyle(e).position),inside:t.left>=r.left&&t.right<=r.right&&m.left>=r.left&&m.right<=r.right}})()`;
  try {
    await c.connect();
    await c.rpc("projects.visit", {
      directory: f.entries[0].directory,
      active: true,
    });
    f.add({
      ...f.entries[0],
      id: "row-action-phantom",
      title: "Working",
      status: "busy",
    });
    await b.goto(f.url + "/#/local/otk/otk");
    await b.poll(
      `!!document.querySelector('${row} .otk-project-trailing') && !!document.querySelector('[data-tab=row-action-phantom]')`,
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      assertEquals(
        await b.evaluate(
          `(()=>{const sample=document.createElement('span');sample.style.color='var(--otk-fg-2)';document.body.append(sample);const expected=getComputedStyle(sample).color;sample.remove();const row=document.querySelector('[data-project-sessions~=atmosphera]');return [row,row.querySelector('.otk-project-open')].every(e=>getComputedStyle(e).color===expected)})()`,
        ),
        true,
        "Unselected project text retains its secondary tone when the row owns selection",
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 600,
        y: 500,
      });
      await b.evaluate("document.activeElement?.blur()");
      await b.poll(
        `getComputedStyle(document.querySelector('${row} .otk-project-menu')).opacity==='0'`,
      );
      const before = await b.evaluate<
        { box: number[]; centre: number; positions: string[]; inside: boolean }
      >(geometry);
      assert(before.centre <= .5);
      assert(before.inside);
      assert(
        before.positions.every((p) => p === "static"),
        JSON.stringify(before),
      );
      const point = await b.evaluate<{ x: number; y: number }>(
        `(()=>{const r=document.querySelector('${row}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await b.poll(
        `getComputedStyle(document.querySelector('${row} .otk-project-menu')).opacity==='1' && getComputedStyle(document.querySelector('${row} time')).opacity==='0'`,
      );
      assertEquals(await b.evaluate(geometry), before);
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 600,
        y: 500,
      });
      await b.evaluate(
        `document.querySelector('${row} .otk-project-open').focus()`,
      );
      await b.poll(
        `getComputedStyle(document.querySelector('${row} .otk-project-menu')).opacity==='1'`,
      );
      assertEquals(await b.evaluate(geometry), before);
      await b.key("Tab");
      await b.poll(
        `document.activeElement===document.querySelector('${row} .otk-popover-trigger')`,
      );
      // Native button activation needs the Enter character as well as key events.
      await b.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        text: "\r",
        unmodifiedText: "\r",
      });
      await b.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await b.poll(`!!document.querySelector('${row} :popover-open')`);
      await b.key("Escape");
      await b.poll(
        `!document.querySelector(':popover-open') && document.activeElement===document.querySelector('${row} .otk-popover-trigger')`,
      );
      assertEquals(
        await b.evaluate(
          "document.querySelectorAll('.otk-tab [popover], .otk-tab button[popovertarget]').length",
        ),
        0,
      );
    }
    assertEquals(b.errors, []);
  } finally {
    await c.close();
    await b.close();
    await f.app.stop();
  }
});
