// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { Cdp } from "../support/cdp.ts";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import type { TaskRecord } from "@otk/protocol";

Deno.test("Display preferences title flows fully inside its surface in every theme", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Surface geometry" },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    const browser = await f.browser(server.url);
    await openSession(browser, session.id);
    const failures: string[] = [];
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      await browser.click('.otk-display-menu [aria-label="Display options"]');
      await browser.poll(
        "document.querySelector('.otk-display-menu').matches('details[open]') || !!document.querySelector('.otk-display-menu :popover-open')",
      );
      const result = await browser.evaluate<{ inside: boolean; delta: number }>(
        `(() => {
        const group = document.querySelector('.otk-display-menu fieldset');
        const surface = group.closest('.otk-surface') || group;
        const title = surface.querySelector('h2,legend');
        const r = surface.getBoundingClientRect(), t = title.getBoundingClientRect();
        const css = getComputedStyle(surface);
        const top = r.top + parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop);
        return {inside:t.top >= top - .5 && t.left >= r.left - .5 && t.right <= r.right + .5 && t.bottom <= r.bottom + .5, delta:t.top-top};
      })()`,
      );
      console.info(theme, result);
      if (!result.inside) {
        failures.push(
          `${theme}: title escapes its content box by ${result.delta}px`,
        );
      }
      await browser.click('.otk-display-menu [aria-label="Display options"]');
      await browser.poll(
        "!document.querySelector('.otk-display-menu :popover-open')",
      );
    }
    assert(!failures.length, failures.join("\n"));
  } finally {
    await client?.close();
    await f.stop();
  }
});

async function contained(browser: Cdp, label: string) {
  const result = await browser.evaluate<{ count: number; failures: string[] }>(
    `(() => {
    const visible = [...document.querySelectorAll('dialog[open] .otk-surface, :popover-open .otk-surface')];
    const failures = [];
    for (const surface of visible) {
      const r = surface.getBoundingClientRect(), css = getComputedStyle(surface);
      const box = {left:r.left+parseFloat(css.borderLeftWidth)+parseFloat(css.paddingLeft),
        right:r.right-parseFloat(css.borderRightWidth)-parseFloat(css.paddingRight),
        top:r.top+parseFloat(css.borderTopWidth)+parseFloat(css.paddingTop),
        bottom:r.bottom-parseFloat(css.borderBottomWidth)-parseFloat(css.paddingBottom)};
      for (const el of [...surface.children, ...surface.querySelectorAll(':scope > * > *')]) {
        const t = el.getBoundingClientRect();
        if (!t.width || !t.height) continue;
        if (t.left < box.left-.5 || t.right > box.right+.5 || t.top < box.top-.5 || t.bottom > box.bottom+.5) failures.push(JSON.stringify({element:el.outerHTML.slice(0,160),box,rect:t.toJSON()}));
      }
      const dialog = surface.closest('dialog');
      if (dialog && dialog.querySelectorAll('h1,h2,h3,h4,h5,h6').length !== 1) failures.push('dialog must have exactly one heading');
      const focused = document.activeElement;
      if (focused?.matches(':focus-visible') && surface.contains(focused)) {
        const clip = focused.closest('.otk-surface-body');
        if (clip) {
          const t=focused.getBoundingClientRect(), c=clip.getBoundingClientRect(), s=getComputedStyle(focused);
          const ring=parseFloat(s.outlineWidth)+parseFloat(s.outlineOffset);
          if (t.left-ring < c.left-.5 || t.right+ring > c.right+.5 || t.top-ring < c.top-.5 || t.bottom+ring > c.bottom+.5) failures.push('surface clips the focused control outline');
        }
      }
    }
    return {count:visible.length, failures};
  })()`,
  );
  assertEquals(result.count, 1, `${label}: exactly one visible owner`);
  assertEquals(result.failures, [], label);
}
async function command(browser: Cdp, title: string, id: string) {
  await browser.key("k", 2);
  await browser.poll(
    "!!document.querySelector('dialog[aria-label=Commands][open]')",
  );
  await browser.fill("input[name=command-search]", title);
  await browser.click(`[data-command='${id}']`);
}
Deno.test("every registered dialog and anchored menu shares contained flow and native dismissal", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    browser = await Cdp.launch(root),
    client = new WsClient(f.url);
  try {
    await client.connect();
    const directory = f.entries[0].directory;
    const task = await client.rpc<TaskRecord>("tasks.create", {
      directory,
      name: "Geometry task",
    });
    const sessions: string[] = [];
    for (let n = 0; n < 10; n++) {
      const id = n === 0 ? "otk" : `surface-session-${n}`;
      if (n) f.add({ ...f.entries[0], id, title: `Surface session ${n}` });
      sessions.push(id);
    }
    await client.rpc("tasks.sessions", { id: task.id, sessions });
    await browser.goto(f.url);
    await openSession(browser, "otk");
    await browser.click(`[data-tab='${task.id}']`);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      await browser.click(".otk-display-menu > button");
      await browser.poll(
        "!!document.querySelector('.otk-display-menu :popover-open')",
      );
      await contained(browser, `${theme} display`);
      await browser.click(".otk-display-menu > button");
      await browser.poll("!document.querySelector(':popover-open')");
      await browser.click(".otk-display-menu > button");
      await browser.poll(
        "!!document.querySelector('.otk-display-menu :popover-open')",
      );
      await browser.key("Escape");
      await browser.poll("!document.querySelector(':popover-open')");
      await browser.key("k", 2);
      await browser.poll("!!document.querySelector('dialog[open]')");
      await contained(browser, `${theme} palette`);
      await browser.key("Escape");
      await browser.poll("!document.querySelector('dialog[open]')");
      await browser.click(".otk-keys-entry");
      await browser.poll(
        "!!document.querySelector('dialog[aria-label=\"Keyboard shortcuts\"][open]')",
      );
      await contained(browser, `${theme} keys`);
      await browser.key("Escape");
      await browser.poll("!document.querySelector('dialog[open]')");
      await command(browser, "Choose theme", "theme.open");
      await browser.poll(
        "!!document.querySelector('dialog[aria-label=Theme][open]')",
      );
      await contained(browser, `${theme} theme`);
      await browser.key("Escape");
      await browser.poll("!document.querySelector('dialog[open]')");
      await browser.click(".otk-add-project");
      await browser.poll(
        "!!document.querySelector('dialog[aria-label=\"Add project\"][open]')",
      );
      await contained(browser, `${theme} add project`);
      await browser.key("Escape");
      await browser.poll("!document.querySelector('dialog[open]')");
      await browser.click(".otk-task-new");
      await browser.poll(
        "!!document.querySelector('dialog[aria-label=\"New task\"][open]')",
      );
      await contained(browser, `${theme} task name`);
      await browser.key("Escape");
      await browser.poll("!document.querySelector('dialog[open]')");
      await browser.poll(
        "document.activeElement===document.querySelector('.otk-task-new')",
      );
      await browser.click("[aria-label='Edit prompt']");
      await browser.poll(
        "!!document.querySelector('dialog[open] textarea[name=editor]')",
      );
      await contained(browser, `${theme} editor`);
      await browser.key("Escape");
      await browser.poll("!document.querySelector('dialog[open]')");
      await browser.poll(
        "document.activeElement===document.querySelector('[aria-label=\"Edit prompt\"]')",
      );
      assertEquals(
        await browser.evaluate(
          "document.querySelectorAll('.otk-tab button[popovertarget], .otk-tab [popover]').length",
        ),
        0,
      );
      await browser.click(".otk-folded-crumbs > button");
      await browser.poll(
        "!!document.querySelector('.otk-folded-crumbs :popover-open')",
      );
      await contained(browser, `${theme} folded crumbs`);
      await browser.key("Escape");
      await browser.poll("!document.querySelector(':popover-open')");
      await browser.click(".otk-project-menu > button");
      await browser.poll(
        "!!document.querySelector('.otk-project-menu :popover-open')",
      );
      await contained(browser, `${theme} project menu`);
      await browser.click(".otk-inbox-search");
      await browser.poll(
        "!document.querySelector(':popover-open') && !!document.querySelector('dialog[open]')",
      );
      await browser.key("Escape");
      await browser.poll("!document.querySelector('dialog[open]')");
    }
    assertEquals(browser.errors, []);
  } finally {
    await client.close();
    await browser.close();
    await f.app.stop();
  }
});
