// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

test("shared type tokens reach rendered chrome prose code and metadata in both themes", async () => {
  const workspace = await fixture(), root = join(workspace, "type-tokens");
  await Deno.mkdir(root);
  const f = await coreBackendFixture(root, {
    prompt: { prompt: () => Promise.resolve(), abort: () => Promise.resolve() },
  });
  f.app.backend.core.listMessages = () =>
    Promise.resolve([{
      id: "message",
      sessionID: "core",
      role: "user",
      time: { created: 1 },
      parts: [{
        id: "text",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{
            i: "text",
            text: "Shared typography without a visual redesign.",
          }],
        }, { b: "code", lang: "text", text: "const role = 'shared';" }],
      }],
    }]);
  const b = await Cdp.launch(workspace), client = new WsClient(f.url);
  const failures: unknown[] = [];
  try {
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(`${f.url}/#/local/core`);
    await b.poll(
      "!!document.querySelector('.otk-code pre') && !!document.querySelector('.otk-prompt textarea')",
    );
    const selectors = [
      "html",
      ".otk-project-name",
      ".otk-text",
      ".otk-code pre",
      ".otk-prompt textarea",
      ".otk-server-connection",
    ];
    const read = () =>
      b.evaluate<string[][]>(
        `(${
          JSON.stringify(selectors)
        }).map(selector=>{const el=document.querySelector(selector);if(!el)return [];const s=getComputedStyle(el);return [s.fontSize,s.lineHeight]})`,
      );
    const shots = Deno.env.get("OTK_TYPE_TOKEN_SHOTS");
    const capture = async (name: string) => {
      if (!shots) return;
      await Deno.mkdir(shots, { recursive: true });
      await b.evaluate(
        "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
      );
      const geometry = await b.evaluate(
        "[...document.body.querySelectorAll('*')].filter(el=>!['STYLE','SCRIPT','LINK'].includes(el.tagName)).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,class:el.className,rect:[r.x,r.y,r.width,r.height],font:[s.fontFamily,s.fontSize,s.lineHeight,s.fontWeight],border:[s.borderRadius,s.borderWidth]}})",
      );
      await Deno.writeTextFile(
        join(shots, `${name}.json`),
        JSON.stringify(geometry),
      );
      await b.screenshot(join(shots, `${name}.png`));
      await b.evaluate(
        "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
      );
      await b.screenshot(join(shots, `${name}-stable.png`));
    };
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const baseline = await read();
      console.info(theme, "default metrics", baseline);
      await capture(`${theme}-session`);
      await b.evaluate(
        "document.documentElement.style.setProperty('--text-ui','17px');document.documentElement.style.setProperty('--text-meta','19px');document.documentElement.style.setProperty('--text-prose','18px');document.documentElement.style.setProperty('--line-ui','26px');document.documentElement.style.setProperty('--line-prose','32px')",
      );
      try {
        assertEquals(
          await b.evaluate(
            "(()=>{const parent=document.createElement('span'),small=document.createElement('small');parent.style.fontSize='5px';small.textContent='Minimum';parent.append(small);document.body.append(parent);const size=getComputedStyle(small).fontSize;parent.remove();return size})()",
          ),
          "12px",
          "Metadata scale overrides must not change the independent minimum text floor",
        );
        assertEquals(await read(), [
          ["17px", "26px"],
          ["17px", "26px"],
          ["18px", "32px"],
          ["17px", "26px"],
          ["18px", "32px"],
          ["19px", "26px"],
        ]);
      } catch (error) {
        failures.push(error);
      }
      await b.evaluate(
        "['--text-ui','--text-meta','--text-prose','--line-ui','--line-prose'].forEach(name=>document.documentElement.style.removeProperty(name))",
      );
      assertEquals(
        await read(),
        baseline,
        "Removing the injected scale must restore every consumer",
      );
      await b.click(".otk-settings-entry");
      await b.poll("!!document.querySelector('.otk-settings')");
      // Only fixture text is normalized: the real server's random port is not
      // typography. Keep paired captures deterministic without changing paint.
      await b.evaluate(
        "document.querySelector('.otk-settings-content > p code').textContent='http://127.0.0.1:1502'",
      );
      await capture(`${theme}-settings`);
      await b.click(".otk-view-header button");
      await b.poll("!!document.querySelector('.otk-prompt textarea')");
    }
    assertEquals(b.errors, []);
    if (failures.length) {
      throw new AggregateError(
        failures,
        "Shared type consumers bypass their tokens",
      );
    }
  } finally {
    await b.close();
    await client.close();
    await f.app.stop();
  }
});
