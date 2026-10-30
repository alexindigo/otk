// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  OperationFailure,
  type PermissionRequest,
  type QuestionRequest,
  type TaskRecord,
} from "@otk/protocol";
import { Cdp } from "../support/cdp.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { WsClient } from "../support/ws-client.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { openSession } from "../support/browser-fixture.ts";

for (const kind of ["permission", "question"] as const) {
  test(`shared ${kind} notice survives takeover, keeps one pending/error sink and focuses the visible status`, async () => {
    const root = await fixture();
    let held = Promise.withResolvers<void>(),
      fail = true,
      done = false,
      calls = 0;
    const sessionID = "tstv1-core";
    const permission: PermissionRequest = {
      id: "permission-proof",
      sessionID,
      kind: "bash",
      title: "Run the proof",
      patterns: ["echo proof"],
      alwaysPatterns: ["echo *"],
      detail: { kind: "bash", command: "echo proof" },
      time: 1,
    };
    const question: QuestionRequest = {
      id: "question-proof",
      sessionID,
      questions: [{
        text: "Which result?",
        options: [{ label: "One" }],
        custom: true,
        multiple: false,
      }],
    };
    const reply = async (): Promise<void> => {
      calls++;
      await held.promise;
      if (fail) {
        throw new OperationFailure(
          "rejected",
          "request.params",
          new Error("private SQL /secret/path"),
        );
      }
      done = true;
      f.app.connections.content(sessionID, {
        op: kind === "permission" ? "permission.remove" : "question.remove",
        sessionID,
        requestID: kind === "permission" ? permission.id : question.id,
      });
    };
    const f = await coreBackendFixture(
      root,
      kind === "permission"
        ? {
          permissions: {
            listPermissions: () => Promise.resolve(done ? [] : [permission]),
            replyPermission: reply,
          },
        }
        : {
          questions: {
            listQuestions: () => Promise.resolve(done ? [] : [question]),
            answerQuestion: reply,
          },
        },
    );
    const browser = await Cdp.launch(root), probe = new WsClient(f.url);
    try {
      await probe.connect();
      await browser.goto(f.url + "/#/local/" + sessionID);
      const dock = kind === "permission"
        ? ".otk-permission-dock"
        : ".otk-question-dock";
      await browser.poll(`!!document.querySelector('${dock}')`);
      if (kind === "question") {
        await browser.type(
          'textarea[name="question-answer"]',
          "Keep my own answer",
        );
      }
      const submit = kind === "permission"
        ? ".otk-permission-actions button"
        : ".otk-question-submit";
      await browser.click(submit);
      await browser.poll(
        "!!document.querySelector('.otk-takeover-notice .otk-operation-feedback.is-pending')",
      );
      await browser.poll(
        "document.activeElement?.classList.contains('otk-operation-feedback')",
      );
      for (const theme of ["otk-dark", "otk-light"]) {
        await probe.rpc("prefs.set", { key: "theme", value: theme });
        await browser.poll(
          `document.documentElement.dataset.otkTheme==='${theme}'`,
        );
        const observation = await browser.evaluate<
          {
            frames: number;
            pending: number;
            disabled: number;
            hiddenFocus: boolean;
          }
        >(`(() => {const dock=document.querySelector('${dock}'),active=document.activeElement;return {frames:document.querySelectorAll('.otk-composer-notice').length,pending:[...dock.querySelectorAll('[role=status]')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&/Sending (response|answer)/.test(el.textContent)).length,disabled:dock.querySelectorAll('[disabled],[aria-disabled=true]').length,hiddenFocus:!active.getClientRects().length||getComputedStyle(active).visibility==='hidden'}})()`);
        assertEquals(
          await browser.evaluate(
            `(() => {const root=document.querySelector('${dock}');return [...root.querySelectorAll('.otk-permission-actions button,.otk-question-actions button,.otk-question-options button,textarea')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&!el.readOnly).length})()`,
          ),
          0,
          "Submitted attention values are read-only and unavailable reply actions are absent",
        );
        const visibleStatuses = await browser.evaluate<string[]>(
          `[...document.querySelectorAll('${dock} [role=status]')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden').map(el=>el.textContent)`,
        );
        await Deno.writeTextFile(
          join(root, `${kind}-pending-${theme}-proof.json`),
          JSON.stringify({ observation, visibleStatuses }, null, 2),
        );
        await browser.screenshot(join(root, `${kind}-pending-${theme}.png`));
        assertEquals(observation, {
          frames: 1,
          pending: 1,
          disabled: 0,
          hiddenFocus: false,
        });
      }
      held.resolve();
      await browser.poll(
        "!!document.querySelector('.otk-takeover-notice [role=alert]')",
      );
      assertEquals(
        await browser.evaluate(
          "[...document.querySelectorAll('[role=alert]')].filter(el=>el.textContent&&getComputedStyle(el).visibility!=='hidden').length",
        ),
        1,
      );
      if (kind === "question") {
        assertEquals(
          await browser.evaluate(
            "document.querySelector('textarea[name=question-answer]').value",
          ),
          "Keep my own answer",
        );
      }
      for (const theme of ["otk-dark", "otk-light"]) {
        await probe.rpc("prefs.set", { key: "theme", value: theme });
        await browser.poll(
          `document.documentElement.dataset.otkTheme==='${theme}'`,
        );
        await browser.screenshot(join(root, `${kind}-error-${theme}.png`));
      }
      held = Promise.withResolvers<void>();
      fail = false;
      await browser.click(submit);
      await browser.poll(
        "!!document.querySelector('.otk-takeover-notice .is-pending')",
      );
      held.resolve();
      await browser.poll(`!document.querySelector('${dock}')`);
      assertEquals(calls, 2);
      assertEquals(browser.errors, []);
      console.info("Takeover feedback evidence:", root, kind);
    } finally {
      held.resolve();
      await browser.close();
      await probe.close();
      await f.app.stop();
    }
  });
}

test("a dismissed task form keeps its original background project working through collapse and reload", async () => {
  const root = await fixture(), f = await inboxBrowserFixture(root);
  const held = Promise.withResolvers<void>();
  const registry = f.app.requests.options.registry,
    prepare = registry.prepare.bind(registry);
  let executions = 0;
  registry.prepare = (method, params) => {
    const value = prepare(method, params);
    return method === "tasks.create"
      ? {
        ...value,
        run: async (...args) => {
          executions++;
          await held.promise;
          return value.run(...args);
        },
      }
      : value;
  };
  const browser = await Cdp.launch(root), probe = new WsClient(f.url);
  try {
    await probe.connect();
    await browser.goto(f.url);
    await openSession(browser, "tstv1-otk");
    await browser.click(".otk-task-new");
    await browser.type('input[name="taskName"]', "Background perf");
    await browser.click('.otk-form button[type="submit"]');
    await browser.poll(
      "document.querySelector('.otk-form')?.getAttribute('aria-busy')==='true'",
    );
    await browser.click('dialog[open] button[aria-label^="Close "]');
    await openSession(browser, "tstv1-globnotes");
    await probe.rpc("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    const directory = f.entries[0].directory;
    const visible =
      `(() => {const e=document.querySelector('[data-project="${directory}"][data-rollup=working]'),r=e?.getBoundingClientRect();return !!r&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight})()`;
    await browser.poll(visible);
    for (const theme of ["otk-dark", "otk-light"]) {
      await probe.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      await browser.goto(f.url + "/#/local/tstv1-globnotes");
      await browser.poll(visible);
      await browser.screenshot(join(root, `background-reload-${theme}.png`));
    }
    held.resolve();
    await browser.poll(
      `document.querySelector('[data-project="${directory}"]')?.dataset.rollup==='idle'`,
    );
    const tasks = await probe.rpc<TaskRecord[]>("tasks.list", { directory });
    assertEquals(tasks.map((task) => task.name), ["Background perf"]);
    assertEquals(executions, 1);
    assertEquals(browser.errors, []);
    console.info("Background feedback evidence:", root);
  } finally {
    held.resolve();
    await browser.close();
    await probe.close();
    await f.app.stop();
  }
});

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
