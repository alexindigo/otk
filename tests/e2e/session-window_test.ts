// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";
import {
  openSession,
  sentFrames,
  waitForCollapsedPanels,
} from "../support/browser-fixture.ts";
import { join } from "@std/path";
import { registerSessionActions } from "../../core/mod.ts";
import { menuReady } from "../support/menu.ts";
import { OperationFailure, type TaskRecord } from "@otk/protocol";
import { coreBackendFixture } from "../support/core-backend.ts";
import { waitFor } from "../support/opencode.ts";
import { wheelViewport } from "../support/message-viewport.ts";

const viewport = ".otk-project-session-tree";
const search = '[aria-label="Search sessions by title"]';
const menu = ':popover-open [role="menu"][aria-label="Context menu"]';
async function shot(b: Cdp, name: string) {
  const folder = Deno.env.get("OTK_WINDOW_SHOTS");
  if (folder) {
    await Deno.mkdir(folder, { recursive: true });
    await b.screenshot(join(folder, `${name}.png`));
  }
}
async function context(b: Cdp, selector: string) {
  await b.rightClick(selector);
  await menuReady(b, menu);
}
async function scroll(b: Cdp, top: string) {
  const delta = await b.evaluate<number>(
    `(()=>{const e=document.querySelector('${viewport}');return (${top})-e.scrollTop})()`,
  );
  await wheelViewport(b, viewport, delta);
}
const anchorProbe =
  `(()=>{const v=document.querySelector('${viewport}'),r=v.getBoundingClientRect();const row=[...v.querySelectorAll('[data-virtual-key]')].find(e=>e.getBoundingClientRect().bottom>r.top+.5);return row&&{key:row.dataset.virtualKey,offset:row.getBoundingClientRect().top-r.top,top:v.scrollTop}})()`;

test("direct-route Sessions waits for task metadata and paints while the selected transcript is held", async () => {
  const root = await fixture(), f = await coreBackendFixture(root);
  const held = Promise.withResolvers<void>(),
    read = f.app.backend.core.listMessages;
  let reads = 0;
  f.app.backend.core.listMessages = async (...args) => {
    reads++;
    await held.promise;
    return await read(...args);
  };
  const b = await Cdp.launch(root), c = new WsClient(f.url);
  try {
    await c.connect();
    await c.rpc("layout.patch", {
      rightCollapsed: false,
      rightView: "sessions",
    });
    await c.rpc("tasks.create", {
      directory: root,
      name: "Initial grouped work",
      sessions: [f.session.id],
    });
    await b.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(()=>{
        const Native=WebSocket;globalThis.inboxGate={pending:[],release(){this.open=true;for(const [socket,data]of this.pending.splice(0))socket.dispatchEvent(new MessageEvent('message',{data}))}};
        globalThis.WebSocket=class extends Native{constructor(...args){super(...args);this.addEventListener('message',event=>{if(!inboxGate.open&&JSON.parse(event.data).t==='inbox'){inboxGate.pending.push([this,event.data]);event.stopImmediatePropagation()}})}};
      })()`,
    });
    await b.goto(`${f.url}/#/local/${f.session.id}`);
    await waitFor(() => reads, (n) => n > 0);
    await b.poll("inboxGate.pending.length>0");
    assertEquals(
      await b.evaluate("document.querySelectorAll('.otk-session-row').length"),
      0,
      "Unknown task metadata cannot mount an interim ungrouped hierarchy",
    );
    await b.evaluate("inboxGate.release()");
    await b.poll(
      `(()=>{const r=document.querySelector('.otk-session-row[data-session="${f.session.id}"][aria-current="page"]')?.getBoundingClientRect();return !!r&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight})()`,
      2000,
    );
    assertEquals(
      await b.evaluate("document.querySelectorAll('.otk-session-row').length"),
      1,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-session-group-heading[data-session-group] .otk-control-label')?.textContent",
      ),
      "Initial grouped work",
    );
    assertEquals(
      await b.evaluate("document.body.textContent.includes('Core transcript')"),
      false,
    );
    held.resolve();
    await b.poll("document.body.textContent.includes('Core transcript')");
  } finally {
    held.resolve();
    await c.close();
    await b.close();
    await f.app.stop();
  }
});

test("active Sessions windows its DOM and releases it on collapse", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    for (let i = 0; i < 300; i++) {
      f.add({
        ...f.entries[0],
        id: `tstv1-window-${i}`,
        title: `Window session ${i}`,
      });
    }
    // Isolate list demand from M2's intentional project-wide body warming.
    await c.rpc("tasks.create", {
      directory: f.entries[0].directory,
      name: "Selected transcript scope",
      sessions: ["tstv1-otk"],
    });
    await b.goto(f.url);
    await openSession(b, "tstv1-otk");
    await b.poll("!!document.querySelector('.otk-session-row')");
    const count = await b.evaluate<number>(
      "document.querySelectorAll('.otk-session-row').length",
    );
    assert(count < 40, `mounted ${count} rows`);
    console.info("Window population / mounted rows", {
      population: 301,
      mounted: count,
    });
    const rowRequests = sentFrames(b).map((e) => e.frame).filter((frame) =>
      frame.t === "request" &&
      [
        "session.get",
        "session.messages",
        "session.children",
        "models.list",
        "usage.get",
      ].includes(String(frame.method))
    );
    assertEquals(
      rowRequests.filter((frame) =>
        (frame.params as { sessionID?: string })?.sessionID !== "tstv1-otk"
      ).length,
      0,
    );
    await b.click(".otk-panel-collapse");
    await b.poll("!!document.querySelector('.otk-right-rail')");
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-project-sessions').length",
      ),
      0,
    );
  } finally {
    await c.close();
    await b.close();
    await f.app.stop();
  }
});

for (const theme of ["otk-dark", "otk-light"]) {
  test(`Sessions retains measured identity, focus, menu, search and scope in ${theme}`, async () => {
    const root = await fixture(),
      f = await inboxBrowserFixture(root),
      b = await Cdp.launch(root),
      c = new WsClient(f.url);
    let rejectRename = true;
    Object.assign(f.app.backend.capabilities, {
      sessionActions: {
        async rename(id: string, title: string) {
          if (rejectRename) {
            throw new OperationFailure(
              "rejected",
              "request.params",
              new Error("Rename refused; keep the edited title and try again."),
            );
          }
          f.update(id, { title });
          return await f.app.backend.core.getSession(id);
        },
        remove: async () => {},
        fork: (id: string) => f.app.backend.core.getSession(id),
        compact: async () => {},
      },
    });
    registerSessionActions(f.app.connections.rpc, f.app.backend);
    try {
      await c.connect();
      const base = f.entries[0];
      for (let i = 0; i < 300; i++) {
        f.add({
          ...base,
          id: `tstv1-w-${i}`,
          title: `Window session ${String(i).padStart(3, "0")}`,
        });
      }
      const report = (
        id: string,
        cost: number,
        deleted: { at: number; how: "provider" } | null = null,
      ) => {
        const revision = f.app.index.get(id)!.digest.revision + 1;
        f.app.index.applyDigest({
          id,
          revision,
          summary: {
            state: "ready",
            revision,
            total: {
              calls: 1,
              cost,
              tokens: {
                input: 10,
                output: 2,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              contextPeak: 10,
            },
          },
          turns: { upsert: {}, remove: [] },
          deleted,
        });
      };
      report("tstv1-w-299", .125);
      report("tstv1-w-0", 0);
      f.add({
        ...base,
        id: "tstv1-helper",
        parentID: "tstv1-w-10",
        title: "Nested search target",
      });
      const task = await c.rpc<TaskRecord>("tasks.create", {
        directory: base.directory,
        name: "Windowed execution",
        sessions: ["tstv1-w-10", "tstv1-w-11"],
      });
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.goto(`${f.url}/#/local/tstv1-otk`);
      await b.poll("!!document.querySelector('.otk-right-panel')");
      await b.click('[aria-label="Open right panel"]');
      await b.poll("!!document.querySelector('.otk-session-row')");
      await scroll(b, "e.scrollHeight-e.clientHeight");
      await b.poll("!!document.querySelector('[data-session=tstv1-w-299]')");
      assertEquals(
        await b.evaluate(
          "(()=>{const row=document.querySelector('[data-session=tstv1-w-299]').closest('[role=listitem]');return [row.getAttribute('aria-posinset'),row.getAttribute('aria-setsize')]})()",
        ),
        ["302", "302"],
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('[data-session=tstv1-w-299] .otk-session-cost').textContent",
        ),
        "$0.13",
      );
      assert(
        (await b.evaluate<number>(
          "document.querySelectorAll('.otk-session-row').length",
        )) < 40,
      );
      await shot(b, `${theme}-scrolled-hierarchy`);
      // A focused row remains the same DOM identity while far outside the window.
      await b.evaluate(
        "globalThis.pinned=document.querySelector('[data-session=tstv1-w-299]');pinned.focus()",
      );
      await b.evaluate("new Promise(requestAnimationFrame)");
      await scroll(b, "0");
      await b.poll(
        "document.activeElement===globalThis.pinned && pinned.isConnected && !!document.querySelector('[data-session=tstv1-w-10]')",
      );
      await b.evaluate("document.querySelector('input[type=search]').focus()");
      await b.poll("!document.querySelector('[data-session=tstv1-w-299]')");
      report("tstv1-w-299", 2.5);
      // The shared context-menu lifetime pins its origin until dismissal.
      await context(b, "[data-session=tstv1-w-10]");
      await scroll(b, "e.scrollHeight-e.clientHeight");
      await b.poll(
        "document.querySelector('[data-session=tstv1-w-299] .otk-session-cost')?.textContent==='$2.50'",
      );
      assertEquals(
        await b.evaluate(
          "!!document.querySelector('[data-session=tstv1-w-10]')",
        ),
        true,
      );
      await b.key("Escape");
      await b.poll("!document.querySelector(':popover-open [role=menu]')");
      await b.evaluate("document.querySelector('input[type=search]').focus()");
      await scroll(b, "e.scrollHeight-e.clientHeight");
      await b.poll("!document.querySelector('[data-session=tstv1-w-10]')");
      await b.fill(search, "Nested search");
      await b.poll(
        "document.querySelectorAll('.otk-session-row').length===2 && !!document.querySelector('[data-session=tstv1-helper]')",
      );
      await shot(b, `${theme}-search-ancestry`);
      await b.click("[data-session=tstv1-helper]");
      await b.poll("location.hash.endsWith('/tstv1-helper')");
      await b.click("[data-panel-view=timeline]");
      await b.poll("!document.querySelector('.otk-project-sessions')");
      await b.click("[data-panel-view=sessions]");
      await b.poll(
        `document.querySelector('${search}').value==='Nested search'`,
      );
      await b.fill(search, "");
      await scroll(b, "3000");
      const before = await b.evaluate<
        { key: string; offset: number; top: number }
      >(anchorProbe);
      // Reorder and ordinary status/totals keep the visible anchor, not a position.
      await c.rpc("tasks.sessions", {
        id: task.id,
        sessions: ["tstv1-w-11", "tstv1-w-10"],
      });
      f.update("tstv1-w-250", { status: "busy" });
      await b.poll("!!document.querySelector('[data-tab=tstv1-w-250]')");
      const after = await b.evaluate<typeof before>(anchorProbe);
      assertEquals(after.key, before.key);
      assert(Math.abs(after.offset - before.offset) < 1);
      assert(before.key.startsWith("tstv1-"));
      report(before.key, .125, { at: 1700000000000, how: "provider" });
      await b.poll(
        `document.querySelector('[data-session="${before.key}"]')?.classList.contains('is-deleted')`,
      );
      const deletedAnchor = await b.evaluate<typeof before>(anchorProbe);
      assertEquals(deletedAnchor.key, before.key);
      assert(Math.abs(deletedAnchor.offset - before.offset) < 1);
      report(before.key, .125);
      await b.poll(
        `!document.querySelector('[data-session="${before.key}"]').classList.contains('is-deleted')`,
      );
      await b.click(".otk-panel-collapse");
      await b.poll(
        "!document.querySelector('.otk-project-sessions .otk-virtual-list')",
      );
      await b.click(".otk-right-rail [data-panel-view=sessions]");
      await b.poll(`document.querySelector('${viewport}').scrollTop>2900`);
      const restored = await b.evaluate<typeof before>(anchorProbe);
      assertEquals(restored.key, before.key);
      assert(Math.abs(restored.offset - before.offset) < 1);
      // Switching projects retires the old viewport and restores only this scope.
      await b.click(
        "[data-project-sessions~=tstv1-atmosphera] .otk-project-open",
      );
      await b.poll(
        `document.querySelector('${search}').value==='' && !document.querySelector('[data-session=tstv1-w-99]')`,
      );
      await b.fill(search, "Approval");
      await b.click("[data-project-sessions~=tstv1-otk] .otk-project-open");
      await b.poll(
        `document.querySelector('${search}').value==='' && document.querySelector('${viewport}').scrollTop>2900`,
      );
      // A real failing title editor changes measured height and remains pinned.
      await scroll(b, "1500");
      await b.poll("!!document.querySelector('[data-session=tstv1-w-50]')");
      await context(b, "[data-session=tstv1-w-50]");
      await b.click(`${menu} [data-context-command="session.rename"]`);
      await b.poll(
        "!!document.querySelector('[aria-label=\"Rename session\"]')",
      );
      await b.fill('[aria-label="Rename session"]', "Retained editor");
      await scroll(b, "3000");
      const editorAnchor = await b.evaluate<{ key: string; offset: number }>(
        anchorProbe,
      );
      await b.key("Enter");
      await b.poll(
        "!!document.querySelector('.otk-title-editor [role=alert]')",
      );
      assert(
        (await b.evaluate<number>(
          "document.querySelector('.otk-session-row.is-editing').getBoundingClientRect().height",
        )) > 30,
      );
      // Alert DOM precedes the browser's ResizeObserver delivery. Observe the
      // resulting painted geometry, as the shared pointer/menu probes do.
      await b.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const errorAnchor = await b.evaluate<typeof editorAnchor>(anchorProbe);
      assertEquals(errorAnchor.key, editorAnchor.key);
      assert(Math.abs(errorAnchor.offset - editorAnchor.offset) < 1);
      assertEquals(
        await b.evaluate(
          "(()=>{const e=document.querySelector('.otk-project-session-tree');return e.scrollWidth<=e.clientWidth})()",
        ),
        true,
        "Validation feedback must wrap inside the measured viewport",
      );
      assert(
        await b.evaluate(
          "(()=>{const row=document.querySelector('.otk-session-row.is-editing'),a=row.querySelector('input').getBoundingClientRect(),b=row.querySelector('.otk-status-light').getBoundingClientRect(),c=row.querySelector('.otk-list-row-trailing').getBoundingClientRect();const centre=r=>r.y+r.height/2;return Math.abs(centre(a)-centre(b))<=1&&Math.abs(centre(a)-centre(c))<=1})()",
        ),
        "Editor input and primary row slots must share their control centreline",
      );
      await b.evaluate(
        "document.querySelector('.otk-title-editor').scrollIntoView({block:'center'})",
      );
      await shot(b, `${theme}-measured-editor-error`);
      await b.fill(search, "No matching sessions while editing");
      await b.poll(
        "!!document.querySelector('.otk-title-editor') && document.querySelectorAll('.otk-session-row').length===1",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('[aria-label=\"Rename session\"]').value",
        ),
        "Retained editor",
      );
      rejectRename = false;
      await b.click('[aria-label="Rename session"]');
      await b.key("Enter");
      await b.poll(
        "!document.querySelector('.otk-title-editor') && document.querySelector('.otk-project-sessions').textContent.includes('No matching sessions')",
      );
      assertEquals(
        (await c.rpc<{ title: string }>("session.get", {
          sessionID: "tstv1-w-50",
        })).title,
        "Retained editor",
      );
      await b.fill(search, "");
      await b.poll("document.querySelectorAll('.otk-session-row').length>5");
      // Geometry comes from shared row/control roles at both supported panel widths.
      for (const width of [280, 480]) {
        await c.rpc("layout.patch", { rightWidth: width });
        await b.poll(
          `Math.abs(document.querySelector('.otk-right-panel').getBoundingClientRect().width-${width})<1`,
        );
        const differences = await b.evaluate<number[]>(
          `[...document.querySelectorAll('.otk-session-row')].map(e=>{const a=e.querySelector('.otk-status-light').getBoundingClientRect(),b=e.querySelector('.otk-row-title').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)})`,
        );
        assert(differences.every((n) => n <= 1));
        assertEquals(
          await b.evaluate(
            "[...document.querySelectorAll('.otk-session-row .otk-row-title')].every(e=>getComputedStyle(e).whiteSpace==='nowrap')",
          ),
          true,
        );
        const gaps = await b.evaluate<number[]>(
          "(()=>{const c=document.querySelector('.otk-panel-new-session').getBoundingClientRect(),i=document.querySelector('.otk-panel-new-session svg').getBoundingClientRect();return [i.top-c.top,c.bottom-i.bottom,c.right-i.right,i.left-c.left]})()",
        );
        assert(Math.max(...gaps) - Math.min(...gaps) <= 1);
      }
      const frames = sentFrames(b).map((e) => e.frame).filter((f) =>
        f.t === "request"
      );
      assertEquals(frames.filter((f) => f.method === "usage.get").length, 0);
      assertEquals(b.errors, []);
    } finally {
      await Deno.writeTextFile(
        join(root, "window-state.json"),
        JSON.stringify(
          {
            html: await b.evaluate("document.documentElement.outerHTML"),
            errors: b.errors,
          },
          null,
          2,
        ),
      );
      console.info("Window evidence:", root);
      console.info("final browser errors", b.errors);
      await c.close();
      await b.close();
      await f.app.stop();
    }
  });
}

for (const theme of ["otk-dark", "otk-light"]) {
  test(`AXIOM activity survives filtered offscreen unmounted Sessions and collapsed reload in ${theme}`, async () => {
    const root = await fixture(),
      f = await inboxBrowserFixture(root),
      b = await Cdp.launch(root),
      c = new WsClient(f.url);
    try {
      await c.connect();
      await c.rpc("prefs.set", { key: "theme", value: theme });
      const other = f.entries[1],
        project = `[data-project-sessions~=tstv1-atmosphera]`;
      for (let i = 0; i < 100; i++) {
        f.add({ ...f.entries[0], id: `tstv1-axiom-${i}`, title: `Quiet ${i}` });
      }
      await b.goto(f.url);
      await openSession(b, "tstv1-otk");
      await b.fill(search, "no matching title");
      for (const stage of ["filtered", "offscreen", "unmounted", "collapsed"]) {
        if (stage === "offscreen") {
          await b.fill(search, "");
          await scroll(b, "e.scrollHeight-e.clientHeight");
        }
        if (stage === "unmounted") {
          await b.click("[data-panel-view=timeline]");
          await b.poll("!document.querySelector('.otk-project-sessions')");
        }
        if (stage === "collapsed") {
          await b.click('[aria-label="Collapse projects"]');
          await b.click(".otk-panel-collapse");
          await waitForCollapsedPanels(b);
        }
        for (const state of ["working", "blocked", "finished"]) {
          f.update(other.id, {
            status: "busy",
            attention: { ...other.attention },
          });
          if (state === "blocked") {
            f.update(other.id, {
              attention: { ...other.attention, questions: 1 },
            });
          }
          if (state === "finished") {
            f.update(other.id, {
              status: "idle",
              attention: { ...other.attention },
            });
          }
          const light = `${project} .otk-status-light[data-state=${state}]`;
          await b.poll(`!!document.querySelector(${JSON.stringify(light)})`);
          assert(
            await b.evaluate(
              `(()=>{const r=document.querySelector(${
                JSON.stringify(light)
              }).getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})()`,
            ),
          );
        }
      }
      f.add({
        ...other,
        id: "tstv1-background-working",
        title: "Background working",
        status: "busy",
      });
      f.add({
        ...other,
        id: "tstv1-background-blocked",
        title: "Background needs you",
        attention: { ...other.attention, questions: 1 },
      });
      await b.poll(
        `!!document.querySelector('${project} .otk-status-light[data-state=blocked]')`,
      );
      // Restore a different live session when selecting this project. Opening
      // the finished session itself would correctly consume its unseen mark.
      await c.rpc("layout.location", {
        sidecarId: "local",
        directory: other.directory,
        sessionID: "tstv1-background-working",
      });
      await b.reload();
      await waitForCollapsedPanels(b);
      await b.poll(
        `!!document.querySelector('${project} .otk-status-light[data-state=blocked]')`,
      );
      await shot(b, `${theme}-collapsed-background-after-reload`);
      await b.click(`${project} .otk-project-open`);
      await b.poll("location.hash.endsWith('/tstv1-background-working')");
      await b.poll(
        "!!document.querySelector('[data-tab=tstv1-atmosphera] .otk-status-light[data-state=finished]')",
      );
      for (
        const [id, state] of [["tstv1-atmosphera", "finished"], [
          "tstv1-background-working",
          "working",
        ], ["tstv1-background-blocked", "blocked"]]
      ) {
        const selector = `[data-tab=${
          JSON.stringify(id)
        }] .otk-status-light[data-state=${state}]`;
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
          "document.querySelectorAll('.otk-project-sessions').length",
        ),
        0,
      );
      await shot(b, `${theme}-mandatory-phantom-after-reload`);
      assertEquals(b.errors, []);
    } finally {
      await c.close();
      await b.close();
      await f.app.stop();
    }
  });
}
