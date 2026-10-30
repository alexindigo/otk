// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { TaskRecord } from "@otk/protocol";
import { Cdp } from "../support/cdp.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { WsClient } from "../support/ws-client.ts";

test("a forty-second task remains pending through repeat submission and socket replacement and renders one selected perf task", async () => {
  const root = await fixture(), f = await coreBackendFixture(root);
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const registry = f.app.requests.options.registry,
    prepare = registry.prepare.bind(registry);
  let executions = 0;
  registry.prepare = (method, params) => {
    const prepared = prepare(method, params);
    if (method !== "tasks.create") return prepared;
    return {
      ...prepared,
      run: async (...args) => {
        executions++;
        entered.resolve();
        await held.promise;
        return await prepared.run(...args);
      },
    };
  };
  const probe = new WsClient(f.url), browser = await Cdp.launch(root);
  try {
    await probe.connect();
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
      window.requestFrames=[]; window.requestSockets=[];
      window.WebSocket=class extends WebSocket {
        constructor(...args){super(...args);window.requestSockets.push(this);}
        send(value){try{window.requestFrames.push(JSON.parse(value));}catch{}return super.send(value);}
      };
    `,
    });
    await browser.goto(f.url + "/#/local/" + f.session.id);
    await browser.poll(
      "!!document.querySelector('.otk-task-new:not(:disabled)')",
    );
    await browser.click(".otk-task-new");
    await browser.type('input[name="taskName"]', "perf");
    await browser.click('.otk-form button[type="submit"]');
    await entered.promise;
    const start = performance.now(), observations: unknown[] = [];
    const inspect = async () => {
      const state = await browser.evaluate<
        {
          pending: boolean;
          readonly: boolean;
          value: string;
          failed: string[];
          disabled: number;
          bounds: number[];
        }
      >(`(() => {
        const form=document.querySelector('.otk-form'), field=form?.querySelector('input[name="taskName"]'),r=form?.getBoundingClientRect();
        return {pending:form?.getAttribute('aria-busy')==='true' && form.textContent.includes('Creating task'),readonly:field?.readOnly,value:field?.value,
          failed:[...form.querySelectorAll('[role=alert]')].map(el=>el.textContent).filter(Boolean),disabled:form.querySelectorAll('[disabled],[aria-disabled="true"]').length,bounds:[r.x,r.y,r.width,r.height]};
      })()`);
      observations.push({ elapsed: performance.now() - start, ...state });
      assert(state.pending);
      assert(state.readonly);
      assertEquals(state.value, "perf");
      assertEquals(state.failed, []);
      assertEquals(state.disabled, 0);
      assertEquals(await probe.rpc("tasks.list", { directory: root }), []);
      return state.bounds;
    };
    const initial = await inspect();
    await new Promise((resolve) => setTimeout(resolve, 16000));
    assertEquals(await inspect(), initial);
    await browser.screenshot(join(root, "task-pending-dark.png"));
    await browser.evaluate(
      `document.querySelector('form.otk-form').requestSubmit(); window.requestSockets.at(-1).close();`,
    );
    await browser.poll(
      "window.requestFrames.some(frame=>frame.t==='request.resume')",
    );
    await probe.rpc("prefs.set", { key: "theme", value: "otk-light" });
    await browser.poll(
      "document.documentElement.dataset.otkTheme==='otk-light'",
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 31000 - (performance.now() - start)))
    );
    assertEquals(await inspect(), initial);
    await browser.screenshot(join(root, "task-pending-linen.png"));
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 40000 - (performance.now() - start)))
    );
    held.resolve();
    await browser.poll("!document.querySelector('input[name=taskName]')");
    const tasks = await probe.rpc<TaskRecord[]>("tasks.list", {
      directory: root,
    });
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0].name, "perf");
    await browser.poll(
      `document.querySelector('[data-tab="${
        tasks[0].id
      }"]')?.getAttribute('aria-selected')==='true'`,
    );
    assertEquals(executions, 1);
    assertEquals(
      await browser.evaluate(
        "window.requestFrames.filter(frame=>frame.t==='request'&&frame.method==='tasks.create').length",
      ),
      1,
    );
    assertEquals(browser.errors, []);
    await browser.screenshot(join(root, "task-finished-linen.png"));
    await Deno.writeTextFile(
      join(root, "task-feedback-proof.json"),
      JSON.stringify({ observations, executions, task: tasks[0] }, null, 2),
    );
    console.info("Task feedback evidence:", root);
  } finally {
    held.resolve();
    await browser.close();
    await probe.close();
    await f.app.stop();
  }
});
