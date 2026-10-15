// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { WsClient } from "../support/ws-client.ts";
import { join } from "@std/path";
import { runTool } from "../support/rendering.ts";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import type { Cdp } from "../support/cdp.ts";
const picker = "dialog[aria-label=Theme][open]";
Deno.test("unknown persisted theme paints the base in both browsers and after reload without rewriting identity", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", {
      key: "theme",
      value: "plugin:uninstalled",
    });
    const browser = await f.browser("about:blank");
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await browser.goto(server.url);
    const fallback =
      `document.documentElement.dataset.otkTheme === 'plugin:uninstalled' &&
      getComputedStyle(document.documentElement).getPropertyValue('--otk-bg') === '#1a1c1e' &&
      getComputedStyle(document.documentElement).colorScheme === 'dark' &&
      document.querySelector('meta[name="theme-color"]').content === '#1a1c1e'`;
    await browser.poll(fallback);
    const other = await f.browser(server.url);
    await other.poll(fallback);
    await assertRejects(() =>
      client!.rpc("prefs.set", { key: "theme", value: "invalid theme" })
    );
    assertEquals(
      await client.rpc("prefs.get", {}).then((prefs) =>
        (prefs as { theme: string }).theme
      ),
      "plugin:uninstalled",
    );
    await browser.reload();
    await browser.poll(fallback);
    await client.rpc("prefs.set", { key: "theme", value: "otk-light" });
    for (const page of [browser, other]) {
      await page.poll(
        `document.documentElement.dataset.otkTheme === 'otk-light' && getComputedStyle(document.documentElement).getPropertyValue('--otk-bg') === '#f4f6f8'`,
      );
    }
  } finally {
    await client?.close();
    await f.stop();
  }
});
const paint = `(() => {
  const root = document.documentElement, css = getComputedStyle(root);
  return { id:root.dataset.otkTheme, bg:css.getPropertyValue('--otk-bg'), scheme:css.colorScheme,
    meta:document.querySelector('meta[name="theme-color"]').content,
    text:getComputedStyle(document.querySelector('.otk-text')).color,
    code:[...document.querySelectorAll('.otk-code .otk-token')].map(el=>({text:el.textContent,color:getComputedStyle(el).color,style:el.getAttribute('style')})),
    add:getComputedStyle(document.querySelector('.otk-diff-add')).color,
    del:getComputedStyle(document.querySelector('.otk-diff-del')).color,
    wordmark:getComputedStyle(document.querySelector('.otk-brand strong')).color,
    work:globalThis.themeWorkerEvidence };
})()`;
async function choose(browser: Cdp, id: string) {
  await browser.click(`[data-theme-choice='${id}']`);
  await browser.poll(
    `document.documentElement.dataset.otkTheme===${JSON.stringify(id)}`,
  );
}
async function openTheme(browser: Cdp) {
  await browser.key("k", 2);
  await browser.poll(
    "!!document.querySelector('dialog[aria-label=Commands][open]')",
  );
  await browser.fill("input[name=command-search]", "Choose theme");
  await browser.click("[data-command='theme.open']");
  await browser.poll(`!!document.querySelector('${picker}')`);
}
Deno.test("D5 actual session/code/diff paint changes with no worker work; preview/cancel, host save/reload/broadcast and live System", async () => {
  const f = await browserFixture({ edit: "allow" }, {
    prepare: async (oc) => {
      await Deno.writeTextFile(
        join(oc.directory, "theme.ts"),
        "const oldPaint = 1;\n",
      );
    },
  });
  try {
    const seed = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Theme consumers" },
    });
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
      globalThis.themeWorkerEvidence = { created:0, sent:0, received:0, terminated:0 };
      const Native = Worker;
      globalThis.Worker = class extends Native {
        constructor(...args) { super(...args); themeWorkerEvidence.created++;
          this.addEventListener('message',()=>themeWorkerEvidence.received++); }
        postMessage(...args) { themeWorkerEvidence.sent++; return super.postMessage(...args); }
        terminate() { themeWorkerEvidence.terminated++; return super.terminate(); }
      };
    })()`,
    });
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await browser.goto(server.url);
    await openSession(browser, seed.id);
    await runTool(f, browser, seed.id, {
      name: "edit",
      input: {
        filePath: join(f.oc.directory, "theme.ts"),
        oldString: "oldPaint",
        newString: "newPaint",
      },
    });
    f.fake.queue({
      chunks: [
        "Theme consumer text.\n\n```ts\n// Theme comment\nconst orange: number = 7;\nfunction run(name: string) { return name + orange; }\n```\n",
      ],
    });
    await browser.type(
      "textarea[name=prompt]",
      "Show existing code and diff consumers",
    );
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${seed.id}"]').dataset.status==='idle' && [...document.querySelectorAll('.otk-token')].some(el=>el.textContent.includes('Theme comment')) && !!document.querySelector('.otk-diff-add')`,
    );
    // Wait for externally observed work to settle before opening the picker.
    await browser.poll(
      `new Promise(resolve=>{const a=JSON.stringify(themeWorkerEvidence);setTimeout(()=>resolve(a===JSON.stringify(themeWorkerEvidence)),200)})`,
    );
    await browser.fill("textarea[name=prompt]", "Preserve this draft");
    const dark = await browser.evaluate<Record<string, unknown>>(paint);
    assertEquals(dark.bg, "#1a1c1e");
    assertEquals(dark.scheme, "dark");
    assertEquals(dark.meta, dark.bg);
    assertEquals(dark.wordmark, "rgb(224, 230, 237)");
    await browser.evaluate(
      "globalThis.themeTokenNodes=[...document.querySelectorAll('.otk-code .otk-token')]",
    );
    await openTheme(browser);
    await choose(browser, "otk-light");
    const light = await browser.evaluate<Record<string, unknown>>(paint);
    assertEquals(light.bg, "#f4f6f8");
    assertEquals(light.scheme, "light");
    assertEquals(light.meta, light.bg);
    for (const field of ["text", "code", "add", "del"]) {
      assert(
        JSON.stringify(light[field]) !== JSON.stringify(dark[field]),
        field,
      );
    }
    assertEquals(light.wordmark, "rgb(26, 28, 30)");
    assertEquals(
      light.work,
      dark.work,
      "Theme switching must not send, create, dispose or receive highlight work",
    );
    assertEquals(
      await browser.evaluate(
        "themeTokenNodes.every((el,i)=>el===document.querySelectorAll('.otk-code .otk-token')[i])",
      ),
      true,
    );
    assertEquals(
      (light.code as { style: string }[]).map((t) => t.style),
      (dark.code as { style: string }[]).map((t) => t.style),
      "Genuine Shiki variable tokens remain identical",
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) => frame.method === "prefs.set")
        .length,
      0,
    );
    await browser.click(".otk-theme-actions button:first-child");
    await browser.poll(
      `!document.querySelector('${picker}') && document.documentElement.dataset.otkTheme==='otk-dark'`,
    );
    assertEquals(await browser.evaluate(paint), dark);
    await openTheme(browser);
    await choose(browser, "otk-light");
    await browser.key("Escape");
    await browser.poll(
      `!document.querySelector('${picker}') && document.documentElement.dataset.otkTheme==='otk-dark'`,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "Preserve this draft",
    );
    const other = await f.browser(server.url);
    await openSession(other, seed.id);
    await openTheme(browser);
    await choose(browser, "otk-light");
    // A concurrent committed value arrives while preview is owned. Esc restores it, not the opening snapshot.
    await openTheme(other);
    await choose(other, "system");
    await other.click(".otk-theme-actions button:last-child");
    await browser.poll(
      "document.documentElement.dataset.otkTheme==='otk-light'",
    );
    await browser.key("Escape");
    await browser.poll("document.documentElement.dataset.otkTheme==='system'");
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.documentElement).colorScheme",
      ),
      "dark",
    );
    await openTheme(browser);
    await choose(browser, "otk-light");
    await browser.click(".otk-theme-actions button:last-child");
    await browser.poll(
      `!document.querySelector('${picker}') && document.documentElement.dataset.otkTheme==='otk-light'`,
    );
    await other.poll("document.documentElement.dataset.otkTheme==='otk-light'");
    await browser.reload();
    await browser.poll(
      "!!document.querySelector('.otk-prompt') && document.documentElement.dataset.otkTheme==='otk-light'",
    );
    await browser.poll("!!document.querySelector('.otk-code .otk-token')");
    assertEquals(
      (await browser.evaluate<Record<string, unknown>>(paint)).code,
      light.code,
    );
    await openTheme(browser);
    await choose(browser, "system");
    await browser.click(".otk-theme-actions button:last-child");
    await browser.poll(
      `!document.querySelector('${picker}') && document.documentElement.dataset.otkTheme==='system'`,
    );
    await other.poll("document.documentElement.dataset.otkTheme==='system'");
    await browser.poll(
      `new Promise(resolve=>{const a=JSON.stringify(themeWorkerEvidence);setTimeout(()=>resolve(a===JSON.stringify(themeWorkerEvidence)),200)})`,
    );
    const before = await browser.evaluate<Record<string, unknown>>(paint);
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await browser.poll(
      "getComputedStyle(document.documentElement).colorScheme==='light'",
    );
    const systemLight = await browser.evaluate<Record<string, unknown>>(paint);
    assertEquals(systemLight.code, light.code);
    assertEquals(systemLight.work, before.work);
    assertEquals(systemLight.id, "system");
    assertEquals(systemLight.meta, light.bg);
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await browser.poll(
      "getComputedStyle(document.documentElement).colorScheme==='dark'",
    );
    const systemDark = await browser.evaluate<Record<string, unknown>>(paint);
    assertEquals(systemDark.code, dark.code);
    assertEquals(systemDark.work, before.work);
    console.info("D5 consumer evidence", {
      dark,
      light,
      systemDark,
      systemLight,
    });
  } finally {
    await f.stop();
  }
});

Deno.test("theme save rejection stays visible, retains preview and never replaces host committed state", async () => {
  const f = await browserFixture();
  try {
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    // External transport instrumentation sends one invalid preference to the
    // genuine core validator. The application contains no testing seam.
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const send=WebSocket.prototype.send;
        WebSocket.prototype.send=function(data) {
          if(typeof data==='string') {
            const frame=JSON.parse(data);
            if(frame.t==='rpc' && frame.method==='prefs.set' && frame.params.key==='theme') {
              frame.params.value='invalid theme identity'; data=JSON.stringify(frame);
            }
          }
          return send.call(this,data);
        };
      })()`,
    });
    await browser.goto(server.url);
    await browser.poll("!!document.querySelector('.otk-sidebar-commands')");
    await openTheme(browser);
    await choose(browser, "otk-light");
    await browser.poll(
      "!document.querySelector('.otk-theme-actions button:last-child').disabled",
    );
    await browser.click(".otk-theme-actions button:last-child");
    await browser.poll(
      "document.querySelector('dialog[aria-label=Theme] [role=alert]')?.textContent.includes('Invalid preference key or value') && !document.querySelector('.otk-theme-actions button:last-child').disabled",
    );
    await browser.poll(
      "document.querySelector('.otk-toast[data-kind=error]')?.textContent.includes('Invalid preference key or value')",
    );
    assertEquals(
      await browser.evaluate("document.documentElement.dataset.otkTheme"),
      "otk-light",
    );
    await browser.click(".otk-theme-actions button:first-child");
    await browser.poll(
      "!document.querySelector('dialog[aria-label=Theme][open]') && document.documentElement.dataset.otkTheme==='otk-dark'",
    );
    await browser.reload();
    await browser.poll(
      "!!document.querySelector('.otk-sidebar-commands') && document.documentElement.dataset.otkTheme==='otk-dark'",
    );
  } finally {
    await f.stop();
  }
});
