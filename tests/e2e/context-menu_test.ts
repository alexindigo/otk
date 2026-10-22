// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { join } from "@std/path";
import { waitFor } from "../support/opencode.ts";
import type { TaskRecord } from "@otk/protocol";

const menuRoot = '[role="menu"][aria-label="Context menu"]';
const menu = `:popover-open ${menuRoot}`;
async function rightClick(browser: Cdp, selector: string, modifiers = 0) {
  const point = await browser.evaluate<{ x: number; y: number }>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({block:'nearest',behavior:'instant'});
    const r = el.getBoundingClientRect();
    return el.matches('textarea,input') ? {x:r.x+16,y:r.y+12} : {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await pointer(browser, point, modifiers);
}
async function pointer(
  browser: Cdp,
  point: { x: number; y: number },
  modifiers = 0,
) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await browser.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      modifiers,
      button: "right",
      buttons: type === "mousePressed" ? 2 : 0,
      clickCount: 1,
    });
  }
}
async function labels(browser: Cdp) {
  await browser.poll(`!!document.querySelector('${menu}')`);
  return browser.evaluate<string[]>(
    `[...document.querySelectorAll('${menu} button')].map(el=>el.textContent)`,
  );
}
async function action(browser: Cdp, id: string) {
  await browser.click(`[data-context-command="${id}"]`);
}
async function closed(browser: Cdp) {
  await browser.poll(
    `!document.querySelector('${menu}')`,
  );
}
async function setup() {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    browser = await Cdp.launch(root),
    client = new WsClient(f.url);
  await client.connect();
  await browser.goto(f.url);
  await openSession(browser, "otk");
  await browser.send("Browser.grantPermissions", {
    origin: f.url,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  return {
    root,
    f,
    browser,
    client,
    stop: async () => {
      await client.close();
      await browser.close();
      await f.app.stop();
    },
  };
}
async function capture(browser: Cdp, root: string, name: string) {
  if (Deno.env.get("OTK_CONTEXT_SCREENSHOTS")) {
    await browser.screenshot(`${root}/${name}.png`);
  }
}

Deno.test("context menu: trusted right click, native escape hatch, keyboard navigation, fallback effects and four viewport corners", async () => {
  const { browser, client, f, root, stop } = await setup();
  try {
    await rightClick(browser, ".otk-tabs-project");
    assertEquals(await labels(browser), [
      "New session",
      "Open command palette",
      "Display preferences",
    ]);
    await browser.key("End");
    await browser.poll(
      'document.activeElement?.textContent === "Display preferences"',
    );
    await browser.key("Home");
    await browser.poll('document.activeElement?.textContent === "New session"');
    await browser.key("ArrowUp");
    await browser.poll(
      'document.activeElement?.textContent === "Display preferences"',
    );
    await browser.key("ArrowDown");
    await browser.poll('document.activeElement?.textContent === "New session"');
    await browser.key("o");
    await browser.poll(
      'document.activeElement?.textContent === "Open command palette"',
    );
    await browser.key("Enter");
    await browser.poll(
      "!!document.querySelector('dialog[aria-label=\"Commands\"][open]')",
    );
    await browser.key("Escape");
    await browser.poll("!document.querySelector('dialog[open]')");
    await browser.click("textarea[name=prompt]");
    await browser.key("F10", 8);
    assert((await labels(browser)).includes("Paste"));
    await browser.key("Escape");
    await closed(browser);
    await browser.poll(
      'document.activeElement === document.querySelector("textarea[name=prompt]")',
    );
    await browser.key("ContextMenu");
    await labels(browser);
    await browser.key("Escape");
    await closed(browser);
    // Observe defaultPrevented at the end of propagation, without replacing the
    // trusted input gesture or claiming headless CDP paints a native browser menu.
    await browser.evaluate(
      `document.querySelector('.otk-app').addEventListener('contextmenu',e=>globalThis.contextPrevented=e.defaultPrevented,{once:true})`,
    );
    await rightClick(browser, ".otk-tabs-project", 8);
    await browser.poll("globalThis.contextPrevented === false");
    await closed(browser);
    await browser.key("Escape");
    for (const theme of ["otk-dark", "otk-light"]) {
      for (const key of ["ContextMenu", "F10"]) {
        await browser.evaluate("document.activeElement.blur()");
        assertEquals(
          await browser.evaluate("document.activeElement === document.body"),
          true,
        );
        await browser.key(key, key === "F10" ? 8 : 0);
        assertEquals(await labels(browser), [
          "New session",
          "Open command palette",
          "Display preferences",
        ]);
        await browser.key("Escape");
        await closed(browser);
      }
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      const viewport = await browser.evaluate<
        { width: number; height: number }
      >("({width:innerWidth,height:innerHeight})");
      for (
        const [name, x, y] of [
          ["top-left", 1, 1],
          ["top-right", viewport.width - 1, 1],
          ["bottom-left", 1, viewport.height - 1],
          ["bottom-right", viewport.width - 1, viewport.height - 1],
        ] as const
      ) {
        await pointer(browser, { x, y });
        await labels(browser);
        await browser.poll(
          `(() => { const p=document.querySelector('${menu}').closest('.otk-popover-panel'); const r=p.getBoundingClientRect(); return r.left>=0 && r.top>=0 && r.right<=innerWidth+.5 && r.bottom<=innerHeight+.5; })()`,
        );
        if (Deno.env.get("OTK_CONTEXT_SCREENSHOTS")) {
          await browser.screenshot(`${root}/${theme}-${name}.png`);
        }
        await browser.key("Escape");
        await closed(browser);
      }
      await capture(browser, root, `${theme}-app-before`);
      await rightClick(browser, ".otk-tabs-project");
      await labels(browser);
      if (Deno.env.get("OTK_CONTEXT_SCREENSHOTS")) {
        await browser.screenshot(`${root}/${theme}-app.png`);
      }
      await action(browser, "display.open");
      await browser.poll(
        "!!document.querySelector('dialog[aria-label=\"Display preferences\"][open]')",
      );
      await capture(browser, root, `${theme}-display-dialog`);
      await rightClick(browser, 'dialog input[name="showCost"]');
      await labels(browser);
      await browser.poll(
        "document.activeElement?.closest('[role=menu]') !== null",
      );
      await capture(browser, root, `${theme}-modal-menu`);
      await browser.key("End");
      await browser.poll(
        'document.activeElement?.textContent === "Display preferences"',
      );
      await browser.key("Home");
      await browser.poll(
        'document.activeElement?.textContent === "New session"',
      );
      await browser.key("Escape");
      await closed(browser);
      assertEquals(
        await browser.evaluate("!!document.querySelector('dialog[open]')"),
        true,
      );
      await browser.poll("!!document.activeElement?.closest('dialog[open]')");
      await browser.click('dialog input[name="showCost"]');
      await browser.poll(
        `document.querySelector('dialog input[name="showCost"]').checked === ${
          theme !== "otk-dark"
        }`,
      );
      await browser.key("Escape");
      await browser.poll("!document.querySelector('dialog[open]')");
      await browser.click(".otk-keys-entry");
      await browser.poll(
        "!!document.querySelector('dialog[aria-label=\"Keyboard shortcuts\"][open]')",
      );
      await capture(browser, root, `${theme}-keys-help`);
      await browser.key("Escape");
      await browser.poll("!document.querySelector('dialog[open]')");
    }
    const before = f.entries.length;
    await rightClick(browser, ".otk-tabs-project");
    await action(browser, "session.new");
    await browser.poll(
      'location.hash && !location.hash.endsWith("/otk") && document.querySelector("textarea[name=prompt]")',
    );
    assertEquals(f.entries.length, before + 1);
    assertEquals(browser.errors, []);
    console.info("context screenshot root", root);
  } finally {
    await stop();
  }
});

Deno.test("context menu: editing uses captured ranges and the real clipboard, paste rejection stays in place, links/images/selection copy", async () => {
  const { browser, client, f, root, stop } = await setup();
  const field = 'textarea[name="prompt"]';
  try {
    await browser.fill(field, "Cut this, keep that");
    await browser.evaluate(
      `document.querySelector('${field}').setSelectionRange(0,8)`,
    );
    await rightClick(browser, field);
    assertEquals(await labels(browser), [
      "Cut",
      "Copy",
      "Paste",
      "Select all",
      "Edit prompt",
      "Attach files",
    ]);
    await action(browser, "context.editable.copy");
    await closed(browser);
    assertEquals(
      await browser.evaluate("navigator.clipboard.readText()"),
      "Cut this",
    );
    await rightClick(browser, field);
    await labels(browser);
    await action(browser, "context.editable.cut");
    await browser.poll(
      `document.querySelector('${field}').value === ', keep that'`,
    );
    await closed(browser);
    await rightClick(browser, field);
    await labels(browser);
    const pasted = await browser.evaluate<string>(
      `(() => {const el=document.querySelector('${field}');return el.value.slice(0,el.selectionStart)+'Cut this'+el.value.slice(el.selectionEnd)})()`,
    );
    await action(browser, "context.editable.paste");
    await browser.poll(
      `document.querySelector('${field}').value === ${JSON.stringify(pasted)}`,
    );
    await closed(browser);
    // Native undo proves the field owner receives a real browser editing intent.
    await browser.key("z", 2);
    await browser.poll(
      `document.querySelector('${field}').value === ', keep that'`,
    );
    await rightClick(browser, field);
    await action(browser, "context.editable.selectAll");
    await closed(browser);
    await browser.poll(
      `(() => {const el=document.querySelector('${field}');return el.selectionStart===0&&el.selectionEnd===el.value.length})()`,
    );
    for (const type of ["number", "email"]) {
      const original = type === "number" ? "123" : "old@example.com";
      const replacement = type === "number" ? "456" : "new@example.com";
      await browser.evaluate(
        `(()=>{const el=document.createElement('input');el.type='${type}';el.id='edit-${type}';el.value='${original}';el.addEventListener('input',()=>el.dataset.observed=el.value);document.querySelector('.otk-messages').prepend(el)})()`,
      );
      await rightClick(browser, `#edit-${type}`);
      assertEquals(await labels(browser), [
        "Paste",
        "Select all",
        "Pin as task",
        "Copy session title",
      ]);
      await action(browser, "context.editable.selectAll");
      await closed(browser);
      await browser.evaluate(`navigator.clipboard.writeText('${replacement}')`);
      await rightClick(browser, `#edit-${type}`);
      assertEquals(await labels(browser), [
        "Paste",
        "Select all",
        "Pin as task",
        "Copy session title",
      ]);
      await action(browser, "context.editable.paste");
      await closed(browser);
      await browser.poll(
        `document.querySelector('#edit-${type}').dataset.observed === '${replacement}'`,
      );
      await browser.key("z", 2);
      await browser.poll(
        `document.querySelector('#edit-${type}').value === '${original}'`,
      );
    }
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      await rightClick(browser, field);
      await labels(browser);
      if (Deno.env.get("OTK_CONTEXT_SCREENSHOTS")) {
        await browser.screenshot(`${root}/${theme}-editable.png`);
      }
      await browser.key("Escape");
      await closed(browser);
    }
    await browser.send("Browser.resetPermissions");
    await browser.send("Browser.setPermission", {
      permission: { name: "clipboard-read" },
      setting: "denied",
    });
    await rightClick(browser, field);
    await action(browser, "context.editable.paste");
    await browser.poll(
      `${
        JSON.stringify(
          "The browser didn't allow pasting from the menu — paste from the keyboard",
        )
      } === document.querySelector(':popover-open [role=alert]')?.textContent`,
    );
    assertEquals(
      await browser.evaluate(
        `(()=>{const alert=document.querySelector(':popover-open [role=alert]'),item=document.querySelector('[data-context-command="context.editable.paste"]');return !alert.closest('[role=menu]')&&item.getAttribute('aria-describedby')===alert.id})()`,
      ),
      true,
    );
    assertEquals(
      await browser.evaluate(`document.querySelector('${field}').value`),
      ", keep that",
    );
    if (Deno.env.get("OTK_CONTEXT_SCREENSHOTS")) {
      for (const theme of ["otk-dark", "otk-light"]) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        await browser.poll(
          `document.documentElement.dataset.otkTheme === '${theme}'`,
        );
        await capture(browser, root, `${theme}-paste-error`);
      }
    }
    await browser.key("Escape");
    await closed(browser);
    await browser.send("Browser.grantPermissions", {
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    // Real semantic DOM built-ins need no context binding or per-element listener.
    await browser.evaluate(
      `(() => {const host=document.querySelector('.otk-welcome') || document.querySelector('.otk-messages'); const p=document.createElement('p');p.id='context-probe'; const link=document.createElement('a');link.href=location.origin+'/api/health';link.textContent='Context link';p.append(link);const image=document.createElement('img');image.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="orange"/></svg>';image.alt='Context image';p.append(image);host.prepend(p)})()`,
    );
    await rightClick(browser, "#context-probe a");
    assertEquals(await labels(browser), [
      "Open link in new tab",
      "Copy link address",
      "Pin as task",
      "Copy session title",
    ]);
    await action(browser, "context.link.copy");
    await closed(browser);
    assertEquals(
      await browser.evaluate("navigator.clipboard.readText()"),
      `${f.url}/api/health`,
    );
    await rightClick(browser, "#context-probe a");
    await labels(browser);
    await action(browser, "context.link.open");
    await closed(browser);
    const opened = await waitFor(async () => {
      const targets = await browser.send("Target.getTargets");
      return (targets.targetInfos as { url: string; targetId: string }[]).find((
        target,
      ) => target.url === `${f.url}/api/health`);
    }, (target) => !!target);
    await browser.send("Target.closeTarget", { targetId: opened!.targetId });
    await browser.send("Page.bringToFront");
    await rightClick(browser, "#context-probe img");
    assertEquals(await labels(browser), [
      "Open image",
      "Copy image address",
      "Pin as task",
      "Copy session title",
    ]);
    await action(browser, "context.image.copy");
    await closed(browser);
    assert(
      (await browser.evaluate<string>("navigator.clipboard.readText()"))
        .startsWith("data:image/svg+xml"),
    );
    await rightClick(browser, "#context-probe img");
    await labels(browser);
    await action(browser, "context.image.open");
    await browser.poll(
      "!!document.querySelector('dialog[open] img[alt=\"Context image\"]')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('dialog[open] img[alt=\"Context image\"]').src",
      ),
      await browser.evaluate(
        'document.querySelector("#context-probe img").src',
      ),
    );
    await browser.key("Escape");
    await browser.poll('!document.querySelector("dialog[open]")');
    await browser.evaluate(
      `document.querySelector('#context-probe a').append(document.querySelector('#context-probe img'))`,
    );
    await rightClick(browser, "#context-probe img");
    assertEquals(await labels(browser), [
      "Open image",
      "Copy image address",
      "Open link in new tab",
      "Copy link address",
      "Pin as task",
      "Copy session title",
    ]);
    await browser.key("Escape");
    await closed(browser);
    await browser.evaluate(
      `(() => {const r=document.createRange();r.selectNodeContents(document.querySelector('#context-probe a'));const s=document.getSelection();s.removeAllRanges();s.addRange(r)})()`,
    );
    await rightClick(browser, "#context-probe a");
    assertEquals(await labels(browser), [
      "Copy",
      "Open link in new tab",
      "Copy link address",
      "Pin as task",
      "Copy session title",
    ]);
    await action(browser, "context.selection.copy");
    await closed(browser);
    assertEquals(
      await browser.evaluate("navigator.clipboard.readText()"),
      "Context link",
    );
    await browser.evaluate(
      `(() => { const el=document.createElement('div');el.id='context-edit';el.contentEditable='true';el.style.minHeight='24px';el.innerHTML='<span>Editable content</span>';document.querySelector('.otk-messages').prepend(el);el.focus();const range=document.createRange();range.selectNodeContents(el.querySelector('span'));const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range) })()`,
    );
    await rightClick(browser, "#context-edit span");
    assertEquals(await labels(browser), [
      "Cut",
      "Copy",
      "Paste",
      "Select all",
      "Pin as task",
      "Copy session title",
    ]);
    await action(browser, "context.editable.cut");
    await closed(browser);
    await browser.poll(
      'document.querySelector("#context-edit").textContent === ""',
    );
    assertEquals(
      await browser.evaluate("navigator.clipboard.readText()"),
      "Editable content",
    );
    await rightClick(browser, "#context-edit");
    await labels(browser);
    await action(browser, "context.editable.paste");
    await closed(browser);
    await browser.poll(
      'document.querySelector("#context-edit").textContent === "Editable content"',
    );
    if (Deno.env.get("OTK_CONTEXT_SCREENSHOTS")) {
      for (const theme of ["otk-dark", "otk-light"]) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        await browser.poll(
          `document.documentElement.dataset.otkTheme === '${theme}'`,
        );
        await rightClick(browser, "#context-probe a");
        await labels(browser);
        await capture(browser, root, `${theme}-link`);
        await browser.key("Escape");
        await closed(browser);
        await rightClick(browser, "#context-probe img");
        await labels(browser);
        await capture(browser, root, `${theme}-nested-image-link`);
        await browser.key("Escape");
        await closed(browser);
      }
    }
    assertEquals(browser.errors, []);
    console.info("context screenshot root", root);
  } finally {
    await stop();
  }
});

Deno.test("context binding: external command contributions, live target data, nested groups and destructive ordering", async () => {
  const root = await fixture(), assets = join(root, "context-dist");
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "tests/support/context-consumer/vite.config.ts",
      "--outDir",
      assets,
      "--logLevel",
      "warn",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
  const f = await inboxBrowserFixture(root, [], {}, assets),
    browser = await Cdp.launch(root);
  try {
    await browser.goto(f.url);
    await browser.poll("!!document.querySelector('#inner')");
    assertEquals(
      await browser.evaluate(
        "document.querySelector('#inner').dataset.composedRef",
      ),
      "yes",
    );
    await rightClick(browser, "#inner");
    assertEquals(await labels(browser), [
      "Inspect code",
      "Inspect original",
      "Close reply",
    ]);
    assertEquals(
      await browser.evaluate(
        `document.querySelectorAll('${menu} [role=group]').length`,
      ),
      2,
    );
    assertEquals(
      await browser.evaluate(
        `document.querySelectorAll('${menu} [role=separator]').length`,
      ),
      2,
    );
    await browser.key("End");
    await browser.key(" ");
    await browser.poll(
      'document.querySelector("#result").textContent === "closed"',
    );
    await closed(browser);
    await browser.click("#rename");
    await browser.click("#disable");
    await rightClick(browser, "#inner");
    assertEquals(await labels(browser), [
      "Inspect code",
      "Inspect changed",
    ]);
    await action(browser, "probe.inner");
    await browser.poll(
      'document.querySelector("#result").textContent === "code:changed"',
    );
    await closed(browser);
    await browser.click("#inner");
    await browser.key("F10", 8);
    await labels(browser);
    await browser.key("Escape");
    await closed(browser);
    await browser.poll(
      'document.activeElement === document.querySelector("#inner")',
    );
    // A keyboard invocation uses the entire element rect, not its bottom-left
    // point. Native anchor flipping must clear the opposite edge at any corner.
    for (
      const [corner, edges] of Object.entries({
        tl: "left:1px;top:1px",
        tr: "right:1px;top:1px",
        bl: "left:1px;bottom:1px",
        br: "right:1px;bottom:1px",
      })
    ) {
      await browser.evaluate(
        `document.querySelector('#inner').style.cssText=${
          JSON.stringify("position:fixed;width:160px;height:40px;")
        }+${JSON.stringify(edges)};document.querySelector('#inner').focus()`,
      );
      await browser.key("ContextMenu");
      await labels(browser);
      await browser.poll(
        `(()=>{const a=document.querySelector('#inner').getBoundingClientRect(),r=document.querySelector('${menu}').closest('.otk-popover-panel').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+.5&&r.bottom<=innerHeight+.5&&(r.bottom<=a.top+.5||r.top>=a.bottom-.5||r.right<=a.left+.5||r.left>=a.right-.5)})()`,
      );
      await capture(browser, root, `rect-${corner}`);
      await browser.key("Escape");
      await closed(browser);
    }
    await browser.evaluate(
      "document.querySelector('#inner').removeAttribute('style')",
    );
    // An unrelated selection never turns a body-focus invocation into text copy.
    await browser.evaluate(
      "(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('#result'));getSelection().removeAllRanges();getSelection().addRange(range);document.activeElement.blur()})()",
    );
    await browser.key("ContextMenu");
    assertEquals(await labels(browser), ["app"]);
    await browser.key("Escape");
    await closed(browser);
    await browser.click("#inner");
    await browser.key("ContextMenu");
    await labels(browser);
    await browser.poll(
      "document.activeElement.matches(':popover-open [role=menu] button')",
    );
    await browser.key("Tab");
    await closed(browser);
    assertEquals(
      await browser.evaluate(
        "document.activeElement === document.querySelector('#inner')",
      ),
      true,
    );
    await rightClick(browser, "#inner");
    await labels(browser);
    await browser.evaluate(
      `window.originalMenu=document.querySelector('${menu}')`,
    );
    await rightClick(browser, `${menu} button`);
    assertEquals(await labels(browser), ["Inspect code", "Inspect changed"]);
    assertEquals(
      await browser.evaluate(
        `window.originalMenu===document.querySelector('${menu}')`,
      ),
      true,
    );
    await browser.key("Escape");
    await closed(browser);
    // Cancellation has no pointerup. A later context invocation must not wait
    // forever for the cancelled button's release.
    await browser.evaluate(
      `(()=>{const el=document.querySelector('#inner');el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:2}));el.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,button:2}));const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.x+8,clientY:r.y+8}))})()`,
    );
    assertEquals(await labels(browser), ["Inspect code", "Inspect changed"]);
    await browser.key("Escape");
    await closed(browser);
    await rightClick(browser, "#inner");
    await labels(browser);
    await browser.evaluate("document.querySelector('#release-inner').click()");
    await browser.poll(
      `JSON.stringify([...document.querySelectorAll('${menu} button')].map(el=>el.textContent)) === JSON.stringify(['Inspect changed','probe.third'])`,
    );
    await action(browser, "probe.outer");
    await browser.poll(
      "document.querySelector('#result').textContent === 'changed'",
    );
    await closed(browser);
    await browser.click("#open-modal");
    await browser.poll('!!document.querySelector("dialog[open]")');
    await browser.click("dialog .otk-display-menu > button");
    await browser.poll(
      "!!document.querySelector('dialog .otk-popover-panel[aria-label=\"Display preferences\"]:popover-open')",
      3000,
    );
    await browser.key("Escape");
    await browser.poll(
      '!document.querySelector("dialog :popover-open") && !!document.querySelector("dialog[open]")',
    );
    await browser.poll(
      'document.activeElement === document.querySelector("dialog .otk-display-menu > button")',
    );
    await browser.click("#modal-field");
    await browser.key("F10", 8);
    await labels(browser);
    await browser.poll(
      '!!document.activeElement?.closest("dialog [role=menu]")',
    );
    await browser.key("ArrowDown");
    await browser.poll('document.activeElement?.textContent === "Select all"');
    await browser.key("Escape");
    await closed(browser);
    await browser.poll(
      'document.activeElement === document.querySelector("#modal-field") && !!document.querySelector("dialog[open]")',
    );
    assertEquals(
      await browser.evaluate(
        `document.querySelectorAll('${menuRoot} [data-context-command]').length`,
      ),
      0,
    );
    await browser.poll(
      "!document.querySelector('dialog .otk-popover-panel[aria-label=\"Context menu\"]')",
      3000,
    );
    await browser.key("Escape");
    await browser.poll('!document.querySelector("dialog[open]")');
    await browser.click("#open-modal");
    await browser.poll('!!document.querySelector("dialog[open]")');
    await browser.click("#modal-field");
    await browser.key("ContextMenu");
    await labels(browser);
    // Removing the active Portal destination must clear the originating owner's
    // targets even if the removed node never delivers a native toggle task.
    await browser.evaluate("document.querySelector('#remove-modal').click()");
    await browser.poll(
      `!document.querySelector('dialog') && !document.querySelector('.otk-context-menu [data-context-command]') && !document.querySelector('.otk-popover-anchor')`,
    );
    await rightClick(browser, "#inner");
    assertEquals(await labels(browser), ["Inspect changed", "probe.third"]);
    await browser.evaluate("document.querySelector('#toggle-menus').click()");
    await browser.poll(
      "!document.querySelector('.otk-context-menu') && !document.querySelector('.otk-popover-anchor')",
    );
    await browser.click("#toggle-menus");
    await rightClick(browser, "#no-viewer");
    assertEquals(await labels(browser), ["Copy image address"]);
    await browser.key("Escape");
    await closed(browser);
    assertEquals(browser.errors, []);
  } finally {
    await browser.close();
    await f.app.stop();
  }
});

Deno.test("round 2: all shared Menu callers distinguish pointer and keyboard opening with compact rows", async () => {
  const { root, f, browser, client, stop } = await setup();
  const projectTrigger =
    "[data-project-sessions~=otk] .otk-project-menu > button";
  const projectMenu = ".otk-project-menu :popover-open [role=menu]";
  const foldedTrigger = ".otk-folded-crumbs > button";
  const foldedMenu = ".otk-folded-crumbs :popover-open [role=menu]";
  const pointerFocus = async (selector: string) => {
    await browser.poll(
      `document.activeElement===document.querySelector('${selector}')`,
      3000,
    );
    assertEquals(
      await browser.evaluate(
        `getComputedStyle(document.activeElement).outlineStyle`,
      ),
      "none",
    );
    assertEquals(
      await browser.evaluate(
        `[...document.querySelectorAll('${selector} button')].some(el=>el===document.activeElement)`,
      ),
      false,
    );
  };
  const itemFocus = async (selector: string, last = false) => {
    await browser.poll(
      `document.activeElement===[...document.querySelectorAll('${selector} button')].${
        last ? "at(-1)" : "at(0)"
      }`,
    );
    await browser.poll(
      `document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle==='solid' && parseFloat(getComputedStyle(document.activeElement).outlineWidth)>0`,
    );
  };
  const density = async (selector: string) => {
    assertEquals(
      await browser.evaluate(
        `[...document.querySelectorAll('${selector} button')].map(el=>el.getBoundingClientRect().height)`,
      ),
      await browser.evaluate(
        `[...document.querySelectorAll('${selector} button')].map(()=>28)`,
      ),
    );
    assertEquals(
      await browser.evaluate(
        `(()=>{const items=document.querySelector('${selector}').getBoundingClientRect(),panel=document.querySelector('${selector}').closest('.otk-popover-panel').getBoundingClientRect();return Math.abs((items.top-panel.top)-(panel.bottom-items.bottom))<.5})()`,
      ),
      true,
      "A menu without status has balanced block padding around its item column",
    );
  };
  const enterTrigger = async () => {
    await browser.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    });
    await browser.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
  };
  try {
    const task = await client.rpc<TaskRecord>("tasks.create", {
      directory: f.entries[0].directory,
      name: "Compact menus",
    });
    const ids = ["otk"];
    for (let n = 1; n < 10; n++) {
      const id = `r2-session-${n}`;
      f.add({ ...f.entries[0], id, title: `Menu session ${n}` });
      ids.push(id);
    }
    await client.rpc("tasks.sessions", { id: task.id, sessions: ids });
    await browser.poll(`!!document.querySelector('[data-tab="${task.id}"]')`);
    await browser.click(`[data-tab="${task.id}"]`);
    await browser.poll(`!!document.querySelector('${foldedTrigger}')`);
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      await browser.fill('textarea[name="prompt"]', "Menu selection");
      await browser.evaluate(
        `document.querySelector('textarea[name="prompt"]').select()`,
      );
      await rightClick(browser, 'textarea[name="prompt"]');
      assertEquals(await labels(browser), [
        "Cut",
        "Copy",
        "Paste",
        "Select all",
        "Edit prompt",
        "Attach files",
      ]);
      await pointerFocus(menu);
      await density(menu);
      await capture(browser, root, `${theme}-editable-pointer`);
      await browser.key("ArrowDown");
      await itemFocus(menu);
      await browser.key("Escape");
      await closed(browser);
      for (const key of ["ContextMenu", "F10"]) {
        await browser.key(key, key === "F10" ? 8 : 0);
        await labels(browser);
        await itemFocus(menu);
        await capture(browser, root, `${theme}-editable-${key.toLowerCase()}`);
        await browser.key("Escape");
        await closed(browser);
      }
      // A live document selection elsewhere must not contaminate a tab's menu.
      await browser.evaluate(
        "(()=>{const el=document.querySelector('.otk-user-bubble');const r=document.createRange();r.selectNodeContents(el);const s=document.getSelection();s.removeAllRanges();s.addRange(r)})()",
      );
      await rightClick(browser, `[data-tab="${task.id}"]`);
      assertEquals((await labels(browser)).includes("Copy"), false);
      await browser.key("Escape");
      await closed(browser);
      assertEquals(
        await browser.evaluate("!!document.getSelection().toString()"),
        true,
      );
      const point = await browser.evaluate<{ x: number; y: number }>(
        `(()=>{const r=document.querySelector('[data-project-sessions~=otk]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await browser.click(projectTrigger);
      await pointerFocus(projectMenu);
      await density(projectMenu);
      await capture(browser, root, `${theme}-project-pointer`);
      await browser.key("ArrowDown");
      await itemFocus(projectMenu);
      await browser.key("Escape");
      await browser.poll("!document.querySelector(':popover-open')");
      await enterTrigger();
      await itemFocus(projectMenu);
      await capture(browser, root, `${theme}-project-keyboard`);
      await browser.key("Escape");
      await browser.poll("!document.querySelector(':popover-open')");
      await browser.click(foldedTrigger);
      await pointerFocus(foldedMenu);
      await density(foldedMenu);
      await capture(browser, root, `${theme}-folded-pointer`);
      await browser.key("ArrowUp");
      await itemFocus(foldedMenu, true);
      await browser.key("Escape");
      await browser.poll("!document.querySelector(':popover-open')");
      await enterTrigger();
      await itemFocus(foldedMenu);
      await capture(browser, root, `${theme}-folded-keyboard`);
      await browser.key("Escape");
      await browser.poll("!document.querySelector(':popover-open')");
    }
    assertEquals(browser.errors, []);
    console.info("Round 2 screenshot root", root);
  } finally {
    await stop();
  }
});
