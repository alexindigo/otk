// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { openSession } from "../support/browser-fixture.ts";
import { menuReady } from "../support/menu.ts";
import {
  legacyMenusScene,
  menuGeometry,
  visualDismiss,
  visualMenu,
  visualMenuRoot,
} from "../support/legacy-menus-scene.ts";
test("context menu: trusted right click, native escape hatch, keyboard navigation, fallback effects and four viewport corners", async () => {
  const f = await legacyMenusScene();
  try {
    const b = f.b;
    await b.goto(f.url);
    await openSession(b, "tstv1-otk");
    const v = await b.evaluate<{ width: number; height: number }>(
      "({width:innerWidth,height:innerHeight})",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await f.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (
        const [x, y] of [[1, 1], [v.width - 1, 1], [1, v.height - 1], [
          v.width - 1,
          v.height - 1,
        ]]
      ) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await b.send("Input.dispatchMouseEvent", {
            type,
            x,
            y,
            button: "right",
            buttons: type === "mousePressed" ? 2 : 0,
            clickCount: 1,
          });
        }
        await menuReady(b, visualMenuRoot);
        await menuGeometry(b, visualMenuRoot);
        await visualDismiss(b);
      }
      await visualMenu(b, ".otk-tabs-project");
      await b.click('[data-context-command="display.open"]');
      await b.poll('!!document.querySelector("dialog[open]")');
      await visualMenu(b, "dialog input[name=showCost]");
      await visualDismiss(b);
      await b.key("Escape");
      await b.poll('!document.querySelector("dialog[open]")');
    }
  } finally {
    await f.close();
  }
});
test("all shared Menu callers distinguish pointer and keyboard opening with compact rows", async () => {
  const f = await legacyMenusScene();
  try {
    const b = f.b;
    await b.goto(f.url);
    await openSession(b, "tstv1-otk");
    const task = await f.rpc("tasks.create", {
      directory: f.lease.directory,
      name: "Compact visual menus",
    }) as { id: string };
    await f.rpc("tasks.sessions", {
      id: task.id,
      sessions: [
        "tstv1-otk",
        ...Array.from({ length: 9 }, (_, n) => `tstv1-r2-session-${n + 1}`),
      ],
    });
    await b.poll(`!!document.querySelector('[data-tab="${task.id}"]')`);
    await b.click(`[data-tab="${task.id}"]`);
    await b.poll('!!document.querySelector(".otk-folded-crumbs > button")');
    for (const theme of ["otk-dark", "otk-light"]) {
      await f.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await visualMenu(b, '[data-crumb="tstv1-otk"]');
      await visualDismiss(b);
      for (
        const [trigger, menu, owner] of [
          [
            '[data-project-sessions~="tstv1-otk"] .otk-project-menu > button',
            ".otk-project-menu :popover-open [role=menu]",
            '[data-project-sessions~="tstv1-otk"] .otk-project-menu',
          ],
          [
            ".otk-folded-crumbs > button",
            ".otk-folded-crumbs :popover-open [role=menu]",
            ".otk-folded-crumbs",
          ],
        ]
      ) {
        const point = await b.evaluate<{ x: number; y: number }>(
          `(()=>{const r=document.querySelector(${
            JSON.stringify(trigger)
          }).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        await b.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
        });
        await b.click(trigger);
        await menuReady(b, menu, owner);
        await menuGeometry(b, menu);
        await b.key("Escape");
        await b.poll('!document.querySelector(":popover-open")');
      }
    }
  } finally {
    await f.close();
  }
});
