// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { TaskRecord } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";
import { openSession } from "../support/browser-fixture.ts";

for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`attention-first project and task lamps, all activity visible in ${theme}`, async () => {
    const root = await fixture(),
      f = await inboxBrowserFixture(root),
      b = await Cdp.launch(root),
      c = new WsClient(f.url);
    const directory = f.entries[0].directory;
    const project = `.otk-project-row[data-project=${
      JSON.stringify(directory)
    }]`;
    const light = (selector: string) =>
      `document.querySelector(${
        JSON.stringify(selector + " .otk-status-light")
      })`;
    try {
      await c.connect();
      for (const entry of f.entries.slice(0, 4)) {
        await c.rpc("projects.visit", {
          directory: entry.directory,
          active: true,
        });
      }
      for (
        const [id, title] of [
          ["running", "Working"],
          ["done", "Review ready"],
          ["blocked", "Needs you"],
        ]
      ) {
        f.add({ ...f.entries[0], id, title });
      }
      const task = await c.rpc<TaskRecord>("tasks.create", {
        directory,
        name: "Review",
        sessions: ["otk", "running", "done"],
      });
      // Individual idle / blue / amber / red tabs alongside the mixed task.
      for (
        const [id, name] of [["idle-tab", "Quiet"], ["blue-tab", "Working"], [
          "amber-tab",
          "Finished",
        ]]
      ) {
        f.add({ ...f.entries[0], id, title: name });
        await c.rpc("tasks.create", { directory, name, sessions: [id] });
      }
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await c.rpc("prefs.set", { key: "animationsOff", value: true });
      await c.rpc("prefs.set", { key: "notify.toast", value: false });
      await b.goto(f.url);
      await openSession(b, "otk");
      f.update("running", { status: "busy" });
      f.update("blue-tab", { status: "busy" });
      f.update("done", { status: "busy" });
      f.update("done", { status: "idle" });
      f.update("amber-tab", { status: "busy" });
      f.update("amber-tab", { status: "idle" });
      const attention = {
        permissions: 1,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      };
      f.update("blocked", { attention });
      // Sidebar also presents all four states.
      f.update("atmosphera", { status: "busy" });
      f.update("globnotes", { status: "busy" });
      f.update("globnotes", { status: "idle" });
      const tab = `[data-tab=${JSON.stringify(task.id)}]`;
      await b.poll(`${light(tab)}?.dataset.state==='finished'`);
      await b.poll(`${light(project)}?.dataset.state==='blocked'`);
      for (const state of ["blocked", "finished", "working", "idle"]) {
        await b.poll(
          `!!document.querySelector(${
            JSON.stringify(
              `.otk-inbox-scroll .otk-status-light[data-state=${state}]`,
            )
          })`,
        );
        const selector =
          `.otk-project-tabs [role=tab] .otk-status-light[data-state=${state}]`;
        await b.poll(`!!document.querySelector(${JSON.stringify(selector)})`);
        assert(
          await b.evaluate(
            `(()=>{const r=document.querySelector(${
              JSON.stringify(selector)
            }).getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`,
          ),
        );
      }
      if (Deno.env.get("OTK_STATUS_LIGHT_SHOTS")) {
        await b.screenshot(join(root, `lights-${theme}.png`));
      }
      await c.rpc("tasks.addSession", { id: task.id, sessionID: "blocked" });
      await b.poll(`${light(tab)}?.dataset.state==='blocked'`);
      // Once the blocking request resolves, the unseen finish outranks work in
      // both aggregate consumers, including after reload and in the sidebar rail.
      f.update("blocked", { attention: { ...attention, permissions: 0 } });
      for (let reload = 0; reload < 2; reload++) {
        if (reload) await b.reload();
        await b.poll(`${light(tab)}?.dataset.state==='finished'`);
        await b.poll(`${light(project)}?.dataset.state==='finished'`);
      }
      await b.click('[aria-label="Collapse projects"]');
      await b.poll(
        "document.querySelector('.otk-project-inbox').dataset.collapsed==='true'",
      );
      await b.poll(`${light(project)}?.dataset.state==='finished'`);
      assertEquals(b.errors, []);
    } finally {
      await c.close();
      await b.close();
      await f.app.stop();
    }
  });
}
