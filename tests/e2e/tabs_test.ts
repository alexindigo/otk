// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { InboxSnapshot, Message, TaskRecord } from "@otk/protocol";
import { createTabs, createTaskActions } from "@otk/client";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";
import {
  openSession,
  waitForCollapsedPanels,
} from "../support/browser-fixture.ts";

const tab = (id: string) => `[data-tab=${JSON.stringify(id)}]`;
async function evidence(b: Cdp, root: string) {
  const state = await b.evaluate(
    "({hash:location.hash,tabs:document.querySelector('.otk-project-tabs')?.outerHTML,error:document.querySelector('.otk-global-error')?.textContent,html:document.documentElement.outerHTML})",
  );
  await Deno.writeTextFile(
    `${root}/tabs-state.json`,
    JSON.stringify({ state, errors: b.errors, events: b.events }, null, 2),
  );
  console.info("Tabs browser evidence:", root);
}
/** Public client owners drive real RPC while tabs have no menu entry point.
 * Package-local units cover the retained UI handlers; return these drivers to
 * the UI when the replacement tab-menu wiring is specified. */
async function taskControls(
  c: WsClient,
  f: Awaited<ReturnType<typeof inboxBrowserFixture>>,
) {
  const directory = f.entries[0].directory;
  const inbox = await c.rpc<InboxSnapshot>("inbox.get", {});
  const actions = createTaskActions({
    call: (method, params) => c.rpc(method, params),
  }, directory);
  const model = createTabs((session) =>
    c.rpc<TaskRecord>("tasks.create", {
      directory: session.directory,
      name: session.title,
      sessions: [session.id],
    })
  );
  model.update({ directory, entries: f.entries, inbox });
  return { actions, model };
}
async function createTask(b: Cdp, name: string) {
  await b.click(".otk-task-new");
  await b.poll("!!document.querySelector('input[name=taskName]')");
  await b.type("input[name=taskName]", name);
  await b.click("dialog button[type=submit]");
  await b.poll("!document.querySelector('dialog')");
}
Deno.test("task tabs create rename reorder and close without deleting sessions; ordered crumbs nest helpers and meter matches backend", async () => {
  const root = await fixture(),
    messages: Record<string, Message[]> = {
      otk: [{
        id: "reply",
        sessionID: "otk",
        role: "assistant",
        time: { created: 1, completed: 2 },
        agent: "build",
        model: { provider: "test", model: "test" },
        tokens: {
          input: 2000,
          output: 100,
          reasoning: 20,
          cache: { read: 500, write: 50 },
        },
        cost: .125,
        interrupted: false,
        parts: [],
      }],
    },
    f = await inboxBrowserFixture(root, [], messages),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    f.add({ ...f.entries[0], id: "second", title: "After review" });
    f.add({
      ...f.entries[0],
      id: "helper",
      parentID: "otk",
      title: "explore: callers",
    });
    f.add({
      ...f.entries[0],
      id: "nested",
      parentID: "helper",
      title: "Inspect caller",
    });
    await b.goto(f.url);
    await openSession(b, "otk");
    await createTask(b, "Plan");
    await createTask(b, "Execution");
    let tasks = await c.rpc<TaskRecord[]>("tasks.list", {});
    const plan = tasks.find((t) => t.name === "Plan")!,
      exec = tasks.find((t) => t.name === "Execution")!;
    await c.rpc("tasks.sessions", { id: exec.id, sessions: ["otk", "second"] });
    await b.poll(`!!document.querySelector(${JSON.stringify(tab(exec.id))})`);
    await b.click(tab(exec.id));
    await b.poll(
      "document.querySelector('[data-crumb=otk]')?.getAttribute('aria-current')==='page' && !!document.querySelector('[data-crumb=helper][data-helper=true]')",
    );
    await b.poll(
      "document.querySelector('.otk-context-meter')?.dataset.tokens==='2670'",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-context-meter').dataset.tokens",
      ),
      "2670",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-context-meter').dataset.cost",
      ),
      "0.125",
    );
    assert(
      !(await b.evaluate<string>(
        "document.querySelector('.otk-context-meter').textContent",
      )).includes("%"),
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-crumb=otk] .otk-status-light').getBoundingClientRect().width",
      ),
      8,
    );
    await b.click("[data-crumb=helper]");
    await b.poll(
      "location.hash.includes('/helper') && document.querySelector('[data-crumb=helper]')?.getAttribute('aria-current')==='page'",
    );
    await b.poll(
      "document.querySelector('[data-crumb=nested]')?.dataset.depth==='2'",
    );
    await b.click("[data-crumb=nested]");
    await b.poll(
      "location.hash==='#/local/otk/nested' && document.querySelector('[data-crumb=nested]')?.getAttribute('aria-current')==='page'",
    );
    await b.click("[data-crumb=helper]");
    await b.poll("location.hash==='#/local/otk/helper'");
    await b.reload();
    await b.poll(
      `document.querySelector('[data-crumb=helper]')?.getAttribute('aria-current')==='page' && document.querySelector(${
        JSON.stringify(tab(exec.id))
      })?.getAttribute('aria-selected')==='true'`,
    );
    await b.click("[data-crumb=second]");
    await b.poll("location.hash.endsWith('/second')");
    await b.click(tab(plan.id));
    await b.click(tab(exec.id));
    await b.poll(
      "location.hash.endsWith('/second') && document.querySelector('[data-crumb=second]')?.getAttribute('aria-current')==='page'",
    );
    await b.type("textarea[name=prompt]", "Keep the task draft");
    await b.click(tab(plan.id));
    await b.poll("!location.hash.endsWith('/second')");
    await b.click(tab(exec.id));
    await b.poll("location.hash.endsWith('/second')");
    assertEquals(
      await b.evaluate("document.querySelector('textarea[name=prompt]').value"),
      "Keep the task draft",
    );
    assertEquals(
      await b.evaluate(
        `document.querySelector(${
          JSON.stringify(tab(exec.id))
        }).getAttribute('aria-selected')`,
      ),
      "true",
    );
    await b.fill("textarea[name=prompt]", "");
    const owner = await taskControls(c, f);
    await owner.actions.rename(exec.id, "Build");
    await b.poll(
      `document.querySelector(${
        JSON.stringify(tab(exec.id))
      })?.textContent.includes('Build')`,
    );
    assertEquals(
      (await c.rpc<TaskRecord[]>("tasks.list", {})).find((t) =>
        t.id === exec.id
      )!.name,
      "Build",
    );
    await owner.actions.reorder([exec.id, plan.id]);
    await b.poll(
      `document.querySelector('.otk-tab-open')?.dataset.tab===${
        JSON.stringify(exec.id)
      }`,
    );
    await owner.actions.reorder([plan.id, exec.id]);
    await b.poll(
      `document.querySelector('.otk-tab-open')?.dataset.tab===${
        JSON.stringify(plan.id)
      }`,
    );
    await owner.actions.reorder([exec.id, plan.id]);
    await b.poll(
      `document.querySelector('.otk-tab-open')?.dataset.tab===${
        JSON.stringify(exec.id)
      }`,
    );
    // Both directions persist; UI-handler units prove the move boundaries.
    assertEquals(
      (await c.rpc<TaskRecord[]>("tasks.list", {})).sort((a, b) =>
        a.order - b.order
      ).map((t) => t.id),
      [exec.id, plan.id],
    );
    await b.click(".otk-new-session");
    await b.poll(
      "location.hash.includes('/') && document.querySelectorAll('[data-crumb]').length===3",
    );
    tasks = await c.rpc<TaskRecord[]>("tasks.list", {});
    assertEquals(tasks.find((t) => t.id === exec.id)!.sessions.length, 3);
    await b.reload();
    await b.poll(
      `document.querySelector('.otk-tab-open')?.dataset.tab===${
        JSON.stringify(exec.id)
      }`,
    );
    await owner.actions.close(exec.id);
    await b.poll(`!document.querySelector(${JSON.stringify(tab(exec.id))})`);
    for (const id of ["otk", "second"]) {
      assert(await c.rpc("session.get", { sessionID: id }));
    }
    assert(
      (await c.rpc<TaskRecord[]>("tasks.list", {})).some((t) =>
        t.id === plan.id
      ),
    );
    assertEquals(b.errors, []);
  } finally {
    await evidence(b, root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
});

Deno.test("long task chains fold in the middle, reveal a chosen session and preserve reduced-colour crumb lights", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    const base = f.entries[0],
      ids = ["otk", ...Array.from({ length: 9 }, (_, i) => `chain-${i}`)];
    for (const id of ids.slice(1)) f.add({ ...base, id, title: id });
    const task = await c.rpc<TaskRecord>("tasks.create", {
      directory: base.directory,
      name: "Long chain",
      sessions: ids,
    });
    await b.goto(f.url + "/#/local/otk");
    await b.poll(
      "!!document.querySelector('.otk-folded-crumbs') && document.querySelectorAll('[data-crumb]').length<10",
    );
    await b.click(".otk-folded-crumbs > button");
    await b.click(".otk-folded-crumbs .otk-menu-items button:nth-child(2)");
    await b.poll(
      "document.querySelector('[data-crumb=chain-2]')?.getAttribute('aria-current')==='page' && location.hash.endsWith('/chain-2')",
    );
    assertEquals(
      await b.evaluate(
        `document.querySelector(${
          JSON.stringify(tab(task.id))
        }).getAttribute('aria-selected')`,
      ),
      "true",
    );
    await c.rpc("prefs.set", { key: "reducedColors", value: true });
    await b.poll(
      "document.documentElement.hasAttribute('data-otk-reduced-colors')",
    );
    assertEquals(
      await b.evaluate(
        "getComputedStyle(document.querySelector('[data-crumb=chain-2] .otk-lamp-shape')).display",
      ),
      "block",
    );
    assertEquals(b.errors, []);
  } finally {
    await evidence(b, root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
});

Deno.test("all four phantom rules render through preview pin double-click send and idle-seen departure", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    const base = f.entries[0];
    for (const id of ["preview-a", "preview-b", "pin", "double", "send"]) {
      f.add({ ...base, id, title: id });
    }
    f.update("otk", { status: "busy" });
    await b.goto(f.url);
    await openSession(b, "preview-a");
    await b.poll(
      `document.querySelector(${
        JSON.stringify(tab("preview-a"))
      })?.closest('.otk-tab').dataset.preview==='true'`,
    );
    await openSession(b, "preview-b");
    await b.poll(
      `!document.querySelector(${
        JSON.stringify(tab("preview-a"))
      }) && !!document.querySelector(${
        JSON.stringify(tab("otk"))
      }) && !!document.querySelector(${JSON.stringify(tab("preview-b"))})`,
    );
    assertEquals(
      await b.evaluate(
        `getComputedStyle(document.querySelector(${
          JSON.stringify(tab("preview-b"))
        })).fontStyle`,
      ),
      "italic",
    );
    await (await taskControls(c, f)).model.pin("preview-b");
    await b.poll(
      "document.querySelector('.otk-tab[data-kind=task]')?.textContent.includes('preview-b')",
    );
    await openSession(b, "double");
    await b.click(tab("double"), 2);
    await b.poll(
      "[...document.querySelectorAll('.otk-tab[data-kind=task]')].some(e=>e.textContent.includes('double'))",
    );
    await openSession(b, "send");
    await b.type("textarea[name=prompt]", "Promote by sending");
    await b.key("Enter");
    await b.poll(
      "[...document.querySelectorAll('.otk-tab[data-kind=task]')].some(e=>e.textContent.includes('send')) && document.querySelector('textarea[name=prompt]').value===''",
    );
    await openSession(b, "pin");
    const task = (await c.rpc<TaskRecord[]>("tasks.list", {})).find((t) =>
      t.name === "send"
    )!;
    await (await taskControls(c, f)).actions.add(task, "pin");
    await b.poll(`!document.querySelector(${JSON.stringify(tab("pin"))})`);
    assert(
      (await c.rpc<TaskRecord[]>("tasks.list", {})).find((t) =>
        t.id === task.id
      )!.sessions.includes("pin"),
    );
    await b.click(tab("otk"));
    f.update("otk", { status: "idle" });
    await b.poll(
      `document.querySelector(${
        JSON.stringify(tab("otk"))
      })?.getAttribute('aria-selected')==='true'`,
    );
    await c.rpc("sessions.seen", { sessionID: "otk" });
    await b.click(tab(task.id));
    await b.poll(`!document.querySelector(${JSON.stringify(tab("otk"))})`);
    assert(await c.rpc("session.get", { sessionID: "otk" }));
    assertEquals(b.errors, []);
  } finally {
    await evidence(b, root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
});

Deno.test("axiom 1: working blocked and unseen-finished ungrouped tabs and rail light stay on-screen after inactive activity and reload", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    const base = f.entries[0];
    for (const id of ["blocked", "finished"]) f.add({ ...base, id, title: id });
    await c.rpc("projects.inactive", {
      directory: base.directory,
      inactive: true,
    });
    f.update("otk", { status: "busy" });
    f.update("blocked", { attention: { ...base.attention, questions: 1 } });
    f.update("finished", { status: "busy" });
    f.update("finished", { status: "idle" });
    await b.goto(f.url);
    await openSession(b, "otk");
    await b.click('[aria-label="Collapse projects"]');
    await b.click(".otk-panel-collapse");
    for (let reload = 0; reload < 2; reload++) {
      if (reload) await b.reload();
      // Independent layout intents settle through authoritative broadcasts.
      // Observe activity only once both requested collapses reach the screen.
      await waitForCollapsedPanels(b);
      for (
        const [id, status] of [["otk", "working"], ["blocked", "blocked"], [
          "finished",
          "finished",
        ]]
      ) {
        const selector = `${tab(id)} .otk-status-light[data-state=${status}]`;
        await b.poll(`!!document.querySelector(${JSON.stringify(selector)})`);
        assert(
          await b.evaluate(
            `(()=>{const r=document.querySelector(${
              JSON.stringify(selector)
            }).getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`,
          ),
        );
      }
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-right-panel').hidden",
        ),
        true,
      );
      assert(
        await b.evaluate(
          `(()=>{const e=document.querySelector('[data-project='+CSS.escape(${
            JSON.stringify(base.directory)
          })+'] .otk-status-light[data-state=blocked]');const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=48})()`,
        ),
      );
    }
    const inbox = await c.rpc<InboxSnapshot>("inbox.get", {});
    assertEquals(
      inbox.projects.find((p) => p.directory === base.directory)!.inactive,
      false,
    );
    assertEquals(b.errors, []);
  } finally {
    await evidence(b, root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
});
