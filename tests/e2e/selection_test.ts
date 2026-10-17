// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import {
  type SelectionGeometry,
  selectionGeometry,
} from "../support/selection-geometry.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("selection flow, state and stable boxes span chrome, menu, palette and picker in all themes and colour modes", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  async function observe(selector: string, minimum: number) {
    const items = await b.evaluate<SelectionGeometry[]>(
      selectionGeometry(selector),
    );
    assert(items.length >= minimum, selector);
    for (const item of items) {
      assertEquals(item.shift, 0, JSON.stringify(item));
      if (item.orientation === "vertical") {
        assertEquals([item.w, item.h], [3, 14]);
        assert(item.centred <= .5, JSON.stringify(item));
        assertEquals(item.position, "static");
      } else assertEquals(item.h, 2);
      assertEquals(
        item.paint === "rgba(0, 0, 0, 0)",
        !item.selected,
        JSON.stringify(item),
      );
      if (item.ariaSelected !== null) {
        assertEquals(item.ariaSelected === "true", item.selected);
      }
      if (item.ariaPressed !== null) {
        assertEquals(item.ariaPressed === "true", item.selected);
      }
      if (item.ariaCurrent !== null) assertEquals(item.ariaCurrent, "page");
    }
  }
  try {
    await c.connect();
    const base = f.entries[0],
      ids = [base.id, ...Array.from({ length: 9 }, (_, i) => `selection-${i}`)];
    for (const id of ids.slice(1)) f.add({ ...base, id, title: id });
    await c.rpc("tasks.create", {
      directory: base.directory,
      name: "Selection chain",
      sessions: ids,
    });
    await c.rpc("layout.patch", { rightCollapsed: false });
    await b.goto(f.url + "/#/local/otk");
    await b.poll(
      "!!document.querySelector('.otk-folded-crumbs') && !!document.querySelector('.otk-session-row[aria-current=page]')",
    );
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (const reduced of [false, true]) {
        await c.rpc("prefs.set", { key: "reducedColors", value: reduced });
        await b.poll(
          `document.documentElement.hasAttribute('data-otk-reduced-colors')===${reduced}`,
        );
        await observe(".otk-project-inbox [data-otk-selection]", 4);
        await observe(".otk-project-sessions [data-otk-selection]", 10);
        await observe(".otk-project-tabs [data-otk-selection]", 3);
        await observe(".otk-panel-icons [data-otk-selection]", 1);
        await b.click(".otk-folded-crumbs > button");
        await b.poll("!!document.querySelector(':popover-open')");
        await observe(
          ".otk-folded-crumbs .otk-menu-items [data-otk-selection]",
          1,
        );
        await b.key("Escape");
        await b.poll("!document.querySelector(':popover-open')");
        await b.key("k", 2);
        await b.poll("!!document.querySelector('input[name=command-search]')");
        await observe(".otk-palette-list [data-otk-selection]", 5);
        await b.fill("input[name=command-search]", "Choose theme");
        await b.poll(
          "document.querySelectorAll('.otk-palette-list button').length===1",
        );
        await b.key("Enter");
        await b.poll(
          "!!document.querySelector('[data-theme-choice][aria-pressed=true]')",
        );
        await observe("[data-theme-choice]", 4);
        await b.key("Escape");
        await b.poll("!document.querySelector('dialog')");
      }
    }
    assertEquals(b.errors, []);
  } finally {
    await c.close();
    await b.close();
    await f.app.stop();
  }
});
