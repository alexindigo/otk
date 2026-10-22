// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";

test("U7 shared rails keep Search and project light geometry, open Sessions and restore collapsed layout", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  const shots = Deno.env.get("OTK_RAIL_SHOTS");
  const capture = async (name: string) => {
    if (!shots) return;
    await Deno.mkdir(shots, { recursive: true });
    await b.screenshot(join(shots, `${name}.png`));
  };
  const geometry = () =>
    b.evaluate<{ search: number; lights: number[] }>(
      `(()=>{const centre=e=>{const r=e.getBoundingClientRect();return r.y+r.height/2};return {search:centre(document.querySelector('.otk-inbox-search')),lights:[...document.querySelectorAll('.otk-project-open .otk-status-light')].map(centre)}})()`,
    );
  try {
    await c.connect();
    f.update("otk", { status: "busy" });
    f.update("atmosphera", {
      attention: { ...f.entries[1].attention, permissions: 1 },
    });
    f.update("globnotes", { status: "busy" });
    f.update("globnotes", { status: "idle" });
    await c.rpc("prefs.set", { key: "animationsOff", value: true });
    await c.rpc("layout.patch", {
      leftCollapsed: false,
      rightCollapsed: false,
    });
    await b.goto(f.url + "/#/local/otk");
    await b.poll(
      "document.querySelectorAll('.otk-project-open').length===4 && !!document.querySelector('[data-session=otk]')",
    );
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "light"]]
    ) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await c.rpc("layout.patch", {
        leftCollapsed: false,
        rightCollapsed: false,
      });
      await b.poll(
        "document.querySelector('.otk-project-inbox').dataset.collapsed==='false' && !document.querySelector('.otk-right-panel').hidden",
      );
      const before = await geometry();
      await capture(`expanded-${name}`);
      await b.click(".otk-corner-left");
      await b.poll(
        "document.querySelector('.otk-project-inbox').dataset.collapsed==='true'",
      );
      await b.click(".otk-corner-right");
      await b.poll("document.querySelector('.otk-right-panel').hidden");
      await capture(`rails-${name}`);
      const lightY = await b.evaluate<number[]>(
        "[...document.querySelectorAll('.otk-project-open .otk-status-light')].map(e=>{const r=e.getBoundingClientRect();return r.y+r.height/2})",
      );
      assertEquals(
        lightY,
        before.lights,
        "Project lights must not move when collapsing",
      );
      assertEquals((await geometry()).search, before.search);
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-inbox-search').getAttribute('aria-label')",
        ),
        "Search commands",
      );
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('.otk-sidebar-rail[data-collapsed=true]')].map(e=>e.getBoundingClientRect().width)",
        ),
        [48, 48],
      );
      assert(
        await b.evaluate(
          "(()=>{const l=document.querySelector('.otk-project-inbox').getBoundingClientRect(),r=document.querySelector('.otk-right-rail').getBoundingClientRect();return l.left===0 && r.right===innerWidth && l.height===innerHeight && r.height===innerHeight})()",
        ),
      );
      assert(
        await b.evaluate(
          "['.otk-corner-left','.otk-corner-right','.otk-inbox-search','.otk-right-rail [data-panel-view=sessions]'].every(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})",
        ),
      );
      await b.click(".otk-inbox-search");
      await b.poll("!!document.querySelector('input[name=command-search]')");
      await capture(`search-${name}`);
      await b.key("Escape");
      await b.poll(
        "!document.querySelector('dialog') && document.activeElement===document.querySelector('.otk-inbox-search')",
      );
      await b.click(".otk-right-rail [data-panel-view=sessions]");
      await b.poll(
        "!document.querySelector('.otk-right-panel').hidden && !!document.querySelector('[data-session=otk]')",
      );
      await capture(`sessions-${name}`);
      await b.click(".otk-corner-right");
      await b.poll("!!document.querySelector('.otk-right-rail')");
      await b.reload();
      await b.poll(
        "document.querySelector('.otk-project-inbox')?.dataset.collapsed==='true' && !!document.querySelector('.otk-right-rail [data-panel-view=sessions]:not(:disabled)')",
      );
      assertEquals((await geometry()).lights, before.lights);
      for (
        const [id, status] of [["otk", "working"], ["atmosphera", "blocked"], [
          "globnotes",
          "finished",
        ]]
      ) {
        assert(
          await b.evaluate(
            `(()=>{const e=document.querySelector('[data-project-sessions~=${id}] .otk-status-light[data-state=${status}]'),r=e?.getBoundingClientRect();return !!r?.width && !!r?.height})()`,
          ),
        );
      }
      assert(
        await b.evaluate(
          "(()=>{const e=document.querySelector('[data-tab=otk]'),r=e?.getBoundingClientRect();return !!r?.width && !!r?.height})()",
        ),
      );
    }
    assertEquals(b.errors, []);
  } finally {
    await Deno.writeTextFile(
      join(root, "rails-state.html"),
      await b.evaluate<string>("document.documentElement.outerHTML"),
    );
    console.info("Rail browser evidence:", root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
});
