// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { TaskRecord } from "@otk/protocol";
import { Cdp } from "../support/cdp.ts";
import { requestScaleFixture } from "../support/request-scale.ts";
import { test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

test("stock scale keeps one task intent pending across socket replacement and renders its one authoritative result", async () => {
  const f = await requestScaleFixture(),
    held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const registry = f.app.requests.options.registry,
    prepare = registry.prepare.bind(registry);
  let effects = 0;
  registry.prepare = (method, params) => {
    const prepared = prepare(method, params);
    if (method !== "tasks.create") return prepared;
    return {
      ...prepared,
      run: async (...args) => {
        effects++;
        entered.resolve();
        await held.promise;
        return await prepared.run(...args);
      },
    };
  };
  const browser = await Cdp.launch(f.root), client = new WsClient(f.url);
  try {
    await client.connect();
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source:
        `window.requestSockets=[];window.requestFrames=[];window.WebSocket=class extends WebSocket{constructor(...args){super(...args);window.requestSockets.push(this)}send(value){window.requestFrames.push(JSON.parse(value));return super.send(value)}}`,
    });
    const sessionID = f.native.manifest.sessions[0].id;
    await browser.goto(f.url + "/#/local/" + sessionID);
    await browser.poll("!!document.querySelector('.otk-task-new')", 120000);
    await browser.click(".otk-task-new");
    await browser.type('input[name="taskName"]', "perf");
    await browser.click('.otk-form button[type="submit"]');
    await entered.promise;
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      await browser.poll(
        "document.querySelector('.otk-form')?.getAttribute('aria-busy')==='true' && document.querySelector('input[name=taskName]')?.readOnly",
      );
      assertEquals(
        await browser.evaluate(
          "document.querySelectorAll('.otk-form [role=alert],.otk-form [disabled]').length",
        ),
        0,
      );
      await browser.screenshot(
        join(f.root, `request-scale-pending-${theme}.png`),
      );
    }
    await browser.evaluate(
      "document.querySelector('.otk-form').requestSubmit();window.requestSockets.at(-1).close()",
    );
    await browser.poll(
      "window.requestFrames.some(frame=>frame.t==='request.resume')",
    );
    assertEquals(effects, 1);
    assertEquals(
      await client.rpc("tasks.list", { directory: f.native.directory }),
      [],
    );
    held.resolve();
    await browser.poll("!document.querySelector('input[name=taskName]')");
    const tasks = await client.rpc<TaskRecord[]>("tasks.list", {
      directory: f.native.directory,
    });
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0].name, "perf");
    await browser.poll(
      `document.querySelector('[data-tab="${
        tasks[0].id
      }"]')?.getAttribute('aria-selected')==='true'`,
    );
    assertEquals(effects, 1);
    assertEquals(browser.errors, []);
    await Deno.writeTextFile(
      join(f.root, "request-scale-result.json"),
      JSON.stringify(
        { effects, task: tasks[0], samples: f.probe.samples.length },
        null,
        2,
      ),
    );
  } finally {
    held.resolve();
    await browser.close();
    await client.close();
  }
});
