// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Preferences, TaskRecord } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { menuReady } from "../support/menu.ts";
import { waitFor } from "../support/opencode.ts";

test("project switches restore the last session and task across reload; closed and missing sessions fall back", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  const directory = f.entries[0].directory;
  const row = (directory: string) =>
    `.otk-project-row[data-project=${
      JSON.stringify(directory)
    }] .otk-project-open`;
  try {
    await c.connect();
    f.add({ ...f.entries[0], id: "remembered", title: "Last session" });
    const task = await c.rpc<TaskRecord>("tasks.create", {
      directory,
      name: "Remember this task",
      sessions: ["remembered"],
    });
    await c.rpc("layout.patch", { rightCollapsed: false });
    await b.goto(f.url);
    await openSession(b, "remembered");
    const restored =
      `location.hash.endsWith('/remembered') && document.querySelector('[data-tab="${task.id}"]')?.getAttribute('aria-selected')==='true' && document.querySelector('.otk-user-bubble')?.textContent.includes('Transcript for remembered')`;
    await b.poll(restored);
    await b.click(row(f.entries[1].directory));
    await b.poll("location.hash.endsWith('/atmosphera')");
    await b.click(row(directory));
    await b.poll(restored);
    await b.click(row(f.entries[1].directory));
    await b.reload();
    await b.poll("!!document.querySelector('.otk-project-row')");
    await b.click(row(directory));
    await b.poll(restored);
    // Close the remembered session through its actual context command.
    const point = await b.evaluate<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector('[data-crumb="remembered"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await b.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "right",
        buttons: type === "mousePressed" ? 2 : 0,
        clickCount: 1,
      });
    }
    const menu = ':popover-open [aria-label="Context menu"]';
    await menuReady(b, menu);
    await b.click(`${menu} [data-context-command="session.close"]`);
    await b.poll("location.hash.startsWith('#project/')");
    await b.click(row(f.entries[1].directory));
    await b.reload();
    await b.poll("!!document.querySelector('.otk-project-row')");
    await b.click(row(directory));
    await b.poll(
      "location.hash.endsWith('/otk') && document.querySelector('.otk-user-bubble')?.textContent.includes('Transcript for otk')",
    );
    // A stale persisted identity cannot select a session from another project.
    await b.click(row(f.entries[1].directory));
    await c.rpc("layout.location", {
      sidecarId: "local",
      directory,
      sessionID: "missing",
    });
    await b.reload();
    await b.poll("!!document.querySelector('.otk-project-row')");
    await b.click(row(directory));
    await b.poll(
      "location.hash.endsWith('/otk') && document.querySelector('.otk-user-bubble')?.textContent.includes('Transcript for otk')",
    );
    const prefs = await waitFor(
      () => c.rpc<Preferences>("prefs.get", {}),
      (prefs) =>
        prefs.shellLayout.projectLocations?.find((p) =>
          p.directory === directory
        )?.sessionID === "otk",
    );
    assertEquals(
      prefs.shellLayout.projectLocations?.find((p) => p.directory === directory)
        ?.sessionID,
      "otk",
    );
    assertEquals(b.errors, []);
  } finally {
    await c.close();
    await b.close();
    await f.app.stop();
  }
});
