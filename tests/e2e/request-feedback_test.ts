// SPDX-License-Identifier: LGPL-3.0-only
// T2 visual remainder: task form paint remains for collection 8.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Cdp } from "../support/cdp.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { WsClient } from "../support/ws-client.ts";

test("a forty-second task remains pending through repeat submission and socket replacement and renders one selected perf task", async () => {
  const root = await fixture(),
    f = await coreBackendFixture(root),
    held = Promise.withResolvers<void>();
  const registry = f.app.requests.options.registry,
    prepare = registry.prepare.bind(registry);
  registry.prepare = (method, params) => {
    const value = prepare(method, params);
    return method === "tasks.create"
      ? {
        ...value,
        run: async (...args) => {
          await held.promise;
          return await value.run(...args);
        },
      }
      : value;
  };
  const browser = await Cdp.launch(root), probe = new WsClient(f.url);
  try {
    await probe.connect();
    await browser.goto(f.url + "/#/local/" + f.session.id);
    await browser.poll("!!document.querySelector('.otk-task-new')");
    await browser.click(".otk-task-new");
    await browser.type("input[name=taskName]", "perf");
    await browser.click(".otk-form button[type=submit]");
    await browser.poll(
      "document.querySelector('.otk-form')?.getAttribute('aria-busy')==='true'",
    );
    const bounds: number[][] = [];
    for (const theme of ["otk-dark", "otk-light"]) {
      await probe.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      bounds.push(
        await browser.evaluate(
          "(()=>{const r=document.querySelector('.otk-form').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()",
        ),
      );
      await browser.screenshot(join(root, `task-pending-${theme}.png`));
    }
    assertEquals(bounds[1], bounds[0]);
  } finally {
    held.resolve();
    await browser.close();
    await probe.close();
    await f.app.stop();
  }
});
