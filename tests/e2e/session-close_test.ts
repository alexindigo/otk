// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { TaskRecord } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { menuReady } from "../support/menu.ts";

const menu = ':popover-open [role="menu"][aria-label="Context menu"]';
const closeItem = `${menu} [data-context-command="session.close"]`;
async function context(b: Cdp, selector: string) {
  const point = await b.evaluate<{ x: number; y: number }>(`(async()=>{
    const el=document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({block:'center',behavior:'instant'});
    await new Promise(requestAnimationFrame);
    const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await b.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "right",
      buttons: type === "mousePressed" ? 2 : 0,
      clickCount: 1,
    });
  }
  await menuReady(b, menu);
  assertEquals(
    await b.evaluate(
      `document.querySelector(${JSON.stringify(closeItem)})?.textContent`,
    ),
    "Close session",
  );
}
async function capture(b: Cdp, root: string, name: string) {
  if (Deno.env.get("OTK_CLOSE_SCREENSHOTS")) {
    await b.screenshot(`${root}/S-${name}.png`);
  }
}

for (const theme of ["otk-dark", "otk-light"]) {
  test(`S1 close tab, task row, helper and transcript preserves Sessions and mandatory activity in ${theme}`, async () => {
    const root = await fixture(),
      f = await inboxBrowserFixture(root),
      b = await Cdp.launch(root),
      client = new WsClient(f.url);
    await client.connect();
    try {
      const directory = f.entries[0].directory;
      await client.rpc("prefs.set", { key: "theme", value: theme });
      f.add({ ...f.entries[0], id: "second", title: "Review session" });
      f.add({
        ...f.entries[0],
        id: "child",
        parentID: "otk",
        title: "Helper session",
      });
      await b.goto(f.url);
      await openSession(b, "otk");
      // The same command is available on every session target, including nested message areas.
      for (
        const selector of [
          '[data-tab="otk"]',
          '[data-crumb="otk"]',
          '[data-session="otk"]',
          ".otk-user-bubble",
        ]
      ) {
        await context(b, selector);
        await b.key("Escape");
      }
      await capture(b, root, `${theme}-before`);
      await context(b, '[data-tab="otk"]');
      await capture(b, root, `${theme}-menu`);
      await b.click(closeItem);
      await b.poll(
        `location.hash.startsWith('#project/') && !document.querySelector('[data-tab="otk"]') && !!document.querySelector('[data-session="otk"]')`,
      );
      await capture(b, root, `${theme}-closed`);
      // Reopening from Sessions restores the ordinary preview.
      await b.click('[data-session="otk"]');
      await b.poll(
        `location.hash.endsWith('/otk') && !!document.querySelector('[data-tab="otk"]')`,
      );
      const task = await client.rpc<TaskRecord>("tasks.create", {
        directory,
        name: "Delivery",
        sessions: ["otk", "second"],
      });
      await b.poll(`!!document.querySelector('[data-tab="${task.id}"]')`);
      await b.click('[data-session="child"]');
      await b.poll(
        `location.hash.endsWith('/otk/child') && !!document.querySelector('[data-crumb="child"]')`,
      );
      await context(b, '[data-crumb="child"]');
      await capture(b, root, `${theme}-child-menu`);
      await b.click(closeItem);
      await b.poll(
        `location.hash.endsWith('/otk') && !document.querySelector('[data-crumb="child"]') && !!document.querySelector('[data-session="child"]')`,
      );
      assertEquals(
        (await client.rpc<TaskRecord[]>("tasks.list", { directory }))[0]
          .sessions,
        ["otk", "second"],
      );
      // Closing a background explicit member mutates only that member and does not navigate.
      await context(b, '[data-session="second"]');
      await b.click(closeItem);
      await b.poll(
        `!document.querySelector('[data-crumb="second"]') && !!document.querySelector('[data-session="second"]')`,
      );
      assertEquals(
        (await client.rpc<TaskRecord[]>("tasks.list", { directory }))[0]
          .sessions,
        ["otk"],
      );
      assertEquals(await b.evaluate("location.hash.endsWith('/otk')"), true);
      // Closing working sessions confirms, then leaves their mandatory phantom visible.
      f.update("otk", { status: "busy" });
      await b.poll(
        `document.querySelector('[data-tab="${task.id}"] .otk-status-light')?.getAttribute('data-state')==='working'`,
      );
      await context(b, ".otk-user-bubble");
      await b.dialog(() => b.click(closeItem), false);
      assertEquals(
        (await client.rpc<TaskRecord[]>("tasks.list", { directory }))[0]
          .sessions,
        ["otk"],
      );
      await context(b, ".otk-user-bubble");
      await b.dialog(() => b.click(closeItem), true);
      assert(
        b.events.some((event) =>
          event.method === "Page.javascriptDialogOpening" &&
          String(event.params.message).includes(
            "phantom tab until it is idle and seen",
          )
        ),
      );
      await b.poll(
        `location.hash.startsWith('#project/') && !!document.querySelector('[data-tab="otk"]')`,
      );
      assertEquals(
        (await client.rpc<TaskRecord[]>("tasks.list", { directory }))[0]
          .sessions,
        [],
      );
      await client.rpc("layout.patch", { rightCollapsed: true });
      await b.reload();
      await b.poll(`!!document.querySelector('[data-tab="otk"]')`);
      await capture(b, root, `${theme}-working-phantom`);
      f.update("otk", { status: "idle" });
      await b.poll(
        `document.querySelector('[data-tab="otk"] .otk-status-light')?.getAttribute('data-state')==='finished'`,
      );
      await client.rpc("sessions.seen", { sessionID: "otk" });
      await b.poll(`!document.querySelector('[data-tab="otk"]')`);
      await client.rpc("layout.patch", { rightCollapsed: false });
      await b.poll(`!!document.querySelector('[data-session="otk"]')`);
      assertEquals(
        (await client.rpc<{ id: string }>("session.get", { sessionID: "otk" }))
          .id,
        "otk",
      );
      await b.click('[data-session="otk"]');
      await b.poll(
        `location.hash.endsWith('/otk') && !!document.querySelector('[data-tab="otk"]')`,
      );
      assertEquals(b.errors, []);
      console.info("S1 screenshot root", root);
    } finally {
      await client.close();
      await b.close();
      await f.app.stop();
    }
  });
}

test("S1 closing a real opencode session preserves its record and reopens from Sessions", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Retained in opencode" },
    });
    const sidecar = await f.sidecar(), b = await f.browser(sidecar.url);
    await openSession(b, session.id);
    await context(b, `[data-tab="${session.id}"]`);
    await b.click(closeItem);
    await b.poll(
      `!document.querySelector('[data-tab="${session.id}"]') && !!document.querySelector('[data-session="${session.id}"]')`,
    );
    assertEquals(
      (await f.oc.request<{ id: string }>(`/session/${session.id}`)).id,
      session.id,
    );
    await b.click(`[data-session="${session.id}"]`);
    await b.poll(
      `location.hash.endsWith('/${session.id}') && !!document.querySelector('[data-tab="${session.id}"]')`,
    );
    // Palette invocation uses the invocation-current session through the same owner.
    await b.key("k", 2);
    await b.poll(`!!document.querySelector('[data-command="session.close"]')`);
    await b.click('[data-command="session.close"]');
    await b.poll(
      `!document.querySelector('[data-tab="${session.id}"]') && location.hash.startsWith('#project/')`,
    );
    assertEquals(
      (await f.oc.request<{ id: string }>(`/session/${session.id}`)).id,
      session.id,
    );
    assertEquals(b.errors, []);
  } finally {
    await f.stop();
  }
});
