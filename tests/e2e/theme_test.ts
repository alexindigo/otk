// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { expandTool, runTool } from "../support/rendering.ts";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
// C13 owns preview/cancel/save/error/System behavior. Seed real consumers once;
// retain only fixed Dark/Linen paint until T3 owns the full theme sweep.
test("D5 actual session/code/diff paint changes with no worker work; preview/cancel, host save/reload/broadcast and live System", async () => {
  const f = await browserFixture({ edit: "allow" }, {
    prepare: async (oc) => {
      await Deno.writeTextFile(
        join(oc.directory, "theme.ts"),
        "const oldPaint = 1;\n",
      );
    },
  });
  try {
    const seed = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Theme consumers" },
      }),
      server = await f.sidecar(),
      b = await f.browser("about:blank");
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(server.url);
    await openSession(b, seed.id);
    await runTool(f, b, seed.id, {
      name: "edit",
      input: {
        filePath: join(f.oc.directory, "theme.ts"),
        oldString: "oldPaint",
        newString: "newPaint",
      },
    });
    await expandTool(b, "[data-tool=edit]");
    f.fake.queue({
      chunks: [
        "Theme consumer text.\n\n```ts\n// Theme comment\nconst orange: number = 7;\nfunction run(name: string) { return name + orange; }\n```\n",
      ],
    });
    await b.type(
      "textarea[name=prompt]",
      "Show existing code and diff consumers",
    );
    await b.key("Enter");
    await b.poll(
      `document.querySelector('[data-session="${seed.id}"]').dataset.status==='idle'&&[...document.querySelectorAll('.otk-token')].some(el=>el.textContent.includes('Theme comment'))&&!!document.querySelector('.otk-tool-add')`,
    );
    const paint =
      `(()=>{const root=document.documentElement,css=getComputedStyle(root);return {bg:css.getPropertyValue('--otk-bg'),scheme:css.colorScheme,meta:document.querySelector('meta[name="theme-color"]').content,text:getComputedStyle(document.querySelector('.otk-text')).color,code:[...document.querySelectorAll('.otk-code .otk-token')].map(el=>({text:el.textContent,color:getComputedStyle(el).color,style:el.getAttribute('style')})),add:getComputedStyle(document.querySelector('.otk-tool-add')).color,del:getComputedStyle(document.querySelector('.otk-tool-del')).color,wordmark:getComputedStyle(document.querySelector('.otk-inbox-brand strong')).color};})()`;
    let dark: Record<string, unknown> | undefined;
    for (const theme of ["otk-dark", "otk-light"]) {
      // The public preference protocol supplies committed fixed states.
      const c = new WsClient(server.url);
      await c.connect();
      try {
        await c.rpc("prefs.set", { key: "theme", value: theme });
      } finally {
        await c.close();
      }
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const value = await b.evaluate<Record<string, unknown>>(paint);
      assertEquals(value.bg, theme === "otk-dark" ? "#1a1c1e" : "#f4eee3");
      assertEquals(value.scheme, theme === "otk-dark" ? "dark" : "light");
      assertEquals(value.meta, value.bg);
      assertEquals(
        value.wordmark,
        theme === "otk-dark" ? "rgb(230, 234, 239)" : "rgb(42, 36, 28)",
      );
      if (dark) {
        for (const field of ["text", "code", "add", "del"]) {
          assert(
            JSON.stringify(value[field]) !== JSON.stringify(dark[field]),
            field,
          );
        }
      } else dark = value;
    }
    assertEquals(b.errors, []);
  } finally {
    await f.stop();
  }
});
