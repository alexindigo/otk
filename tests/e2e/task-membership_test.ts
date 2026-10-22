// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { TaskRecord } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("create-in-task preserves membership changes made while session creation is pending", async () => {
  const root = await fixture(), f = await inboxBrowserFixture(root);
  const b = await Cdp.launch(root), c = new WsClient(f.url);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const create = f.app.backend.core.createSession;
  f.app.backend.core.createSession = async (input) => {
    entered.resolve();
    await release.promise;
    return await create(input);
  };
  try {
    await c.connect();
    // Hold metadata delivery, not RPC results: an unacknowledged broadcast
    // cannot be a prerequisite for preserving authoritative membership.
    await b.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.holdInbox = false;
        window.heldInbox = [];
        window.WebSocket = class extends WebSocket {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', event => {
              if (window.holdInbox && JSON.parse(event.data).t === 'inbox') {
                event.stopImmediatePropagation();
                window.heldInbox.push(() => this.dispatchEvent(new MessageEvent('message', {data:event.data})));
              }
            });
          }
        };
        window.releaseInbox = () => {
          window.holdInbox = false;
          for (const deliver of window.heldInbox.splice(0)) deliver();
        };
      `,
    });
    const base = f.entries[0];
    for (
      const [id, title] of [["kept", "Kept session"], [
        "added",
        "Concurrent addition",
      ]]
    ) {
      f.add({ ...base, id, title });
    }
    const task = await c.rpc<TaskRecord>("tasks.create", {
      directory: base.directory,
      name: "Shared task",
      sessions: [base.id, "kept"],
    });
    await b.goto(f.url + "/#/local/otk");
    await b.poll(
      "!!document.querySelector('[data-crumb=kept]') && !!document.querySelector('.otk-prompt')",
    );
    await b.evaluate("window.holdInbox = true");
    await b.click(".otk-new-session");
    await entered.promise;
    await c.rpc("tasks.sessions", { id: task.id, sessions: ["kept", "added"] });
    await b.poll("window.heldInbox.length > 0");
    release.resolve();
    await b.poll(
      "location.hash.startsWith('#/local/') && !location.hash.endsWith('/otk') && !!document.querySelector('.otk-prompt')",
    );
    const created = await b.evaluate<string>("location.hash.split('/').at(-1)");
    assertEquals((await c.rpc<TaskRecord[]>("tasks.list", {}))[0].sessions, [
      "kept",
      "added",
      created,
    ], "Session creation replaced newer membership");
    await b.evaluate("window.releaseInbox()");
    await b.reload();
    await b.poll(
      "!!document.querySelector('[data-crumb=kept]') && !!document.querySelector('[data-crumb=added]') && !document.querySelector('[data-crumb=otk]') && !!document.querySelector('.otk-prompt')",
    );
    assertEquals(
      await b.evaluate("document.querySelectorAll('[data-crumb]').length"),
      3,
    );
    const shots = Deno.env.get("OTK_MEMBERSHIP_SHOTS");
    if (shots) {
      await Deno.mkdir(shots, { recursive: true });
      for (
        const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
      ) {
        await c.rpc("prefs.set", { key: "theme", value: theme });
        await b.poll(
          `document.documentElement.dataset.otkTheme===${
            JSON.stringify(theme)
          }`,
        );
        await b.screenshot(`${shots}/create-in-task-${name}.png`);
      }
    }
    assertEquals(b.errors, []);
  } finally {
    release.resolve();
    await Deno.writeTextFile(
      `${root}/membership-frames.json`,
      JSON.stringify(b.events),
    );
    console.info("Membership browser evidence:", root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
});
