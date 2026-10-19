// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { Preferences, TaskRecord } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";
import { openSession } from "../support/browser-fixture.ts";

Deno.test("registered panel views, width and collapsed state persist in host preferences; unavailable capabilities stay hidden", async () => {
  const root = await fixture(), assets = join(root, "panel-dist");
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "tests/support/panel-consumer/vite.config.ts",
      "--outDir",
      assets,
      "--logLevel",
      "warn",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
  const f = await inboxBrowserFixture(root, [], {}, assets),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  const capture = async (state: string) => {
    const shots = Deno.env.get("OTK_RAIL_SHOTS");
    if (!shots) return;
    await Deno.mkdir(shots, { recursive: true });
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "light"]]
    ) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await b.screenshot(join(shots, `${state}-${name}.png`));
    }
  };
  try {
    await c.connect();
    await b.goto(f.url);
    await openSession(b, "otk");
    await b.poll(
      "document.querySelector('.otk-right-panel').getBoundingClientRect().width===320",
    );
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('[data-panel-view=unavailable]') || !!document.querySelector('[data-unavailable]')",
      ),
      false,
    );
    await b.click('[data-panel-view="external-view"]');
    await b.poll(
      `document.querySelector('[data-external-view]')?.textContent===${
        JSON.stringify(f.entries[0].directory)
      }`,
    );
    const separator = '[aria-label="Right panel width"]';
    const point = await b.evaluate<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector(${
        JSON.stringify(separator)
      }).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    await b.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await b.poll(
      "document.querySelector('.otk-panel-resizer').hasPointerCapture(1)",
    );
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      x: point.x - 80,
      y: point.y,
      buttons: 1,
    });
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x - 80,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await b.poll(
      "document.querySelector('.otk-right-panel').getBoundingClientRect().width>=398",
    );
    const width = await b.evaluate<number>(
      "document.querySelector('.otk-right-panel').getBoundingClientRect().width",
    );
    assertEquals(
      width,
      400,
      "An 80px gesture grows 320px to 400px regardless of border/grab position",
    );
    await b.reload();
    await b.poll(
      `document.querySelector('[data-external-view]') && document.querySelector('.otk-right-panel').getBoundingClientRect().width===${width}`,
    );
    await b.click(separator);
    await b.key("End");
    await b.poll(
      "document.querySelector('.otk-right-panel').getBoundingClientRect().width===480",
    );
    await b.key("Home");
    await b.poll(
      "document.querySelector('.otk-right-panel').getBoundingClientRect().width===280",
    );
    await b.click(".otk-panel-collapse");
    await b.poll("document.querySelector('.otk-right-panel').hidden");
    await b.poll(
      "!!document.querySelector('.otk-right-rail [data-panel-view=external-view]:not(:disabled)')",
    );
    await capture("external-rail");
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-right-rail [data-panel-view]')].map(e=>e.dataset.panelView)",
      ),
      ["sessions", "external-view"],
    );
    assert(
      await b.evaluate(
        "(()=>{const rows=[...document.querySelectorAll('.otk-right-rail [data-panel-view]')].map(e=>e.getBoundingClientRect());return rows[0].y>=52 && rows[1].y>=rows[0].bottom && Math.abs(rows[0].x-rows[1].x)<.5})()",
      ),
    );
    await b.click('.otk-right-rail [data-panel-view="sessions"]');
    await b.poll(
      "!document.querySelector('.otk-right-panel').hidden && document.querySelector('.otk-panel-content')?.getAttribute('aria-label')==='Sessions'",
    );
    await b.click(".otk-panel-collapse");
    await b.poll(
      "!!document.querySelector('.otk-right-rail [data-panel-view=external-view]')",
    );
    await b.evaluate(
      "document.querySelector('.otk-right-rail [data-panel-view=external-view]').focus()",
    );
    // Native button activation needs Chromium's character event, unlike a
    // keydown-owned application command. Keep this recipe local to the test.
    await b.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    });
    await b.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await b.poll(
      "!document.querySelector('.otk-right-panel').hidden && !!document.querySelector('[data-external-view]')",
    );
    await capture("external-open");
    await b.click(".otk-panel-collapse");
    await b.poll("!!document.querySelector('.otk-right-rail')");
    await b.reload();
    await b.poll(
      "document.querySelector('[aria-label=\"Open right panel\"]:not(:disabled)') && document.querySelector('.otk-right-panel').hidden",
    );
    await b.click('[aria-label="Open right panel"]');
    await b.poll(
      "document.querySelector('[data-external-view]') && document.querySelector('.otk-right-panel').getBoundingClientRect().width===280",
    );
    const prefs = await c.rpc<Preferences>("prefs.get", {});
    assertEquals(prefs.shellLayout.rightView, "external-view");
    assertEquals(prefs.shellLayout.rightWidth, 280);
    assertEquals(prefs.shellLayout.rightCollapsed, false);
    await c.rpc("prefs.set", {
      key: "shellLayout",
      value: { ...prefs.shellLayout, rightView: "uninstalled-view" },
    });
    await b.poll(
      "document.querySelector('[data-panel-view=sessions]')?.getAttribute('aria-selected')==='true'",
    );
    assertEquals(
      (await c.rpc<Preferences>("prefs.get", {})).shellLayout.rightView,
      "uninstalled-view",
    );
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1000,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.poll("innerWidth===1000");
    const geometry = await b.evaluate<number>(
      "(()=>{const a=document.querySelector('.otk-main').getBoundingClientRect(),b=document.querySelector('.otk-right-panel').getBoundingClientRect();return Math.abs(a.right-b.left)})()",
    );
    assert(geometry < .5);
    assertEquals(b.errors, []);
  } finally {
    await Deno.writeTextFile(
      join(root, "panel-state.json"),
      JSON.stringify(
        {
          state: await b.evaluate("document.documentElement.outerHTML"),
          errors: b.errors,
        },
        null,
        2,
      ),
    );
    console.info("Panel browser evidence:", root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
});

Deno.test("Sessions groups the selected project's parent-child tree by task, filters titles and opens previews and solid tasks", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    c = new WsClient(f.url);
  try {
    await c.connect();
    const base = f.entries[0];
    f.add({ ...base, id: "helper", parentID: "otk", title: "Explore callers" });
    f.add({
      ...base,
      id: "nested",
      parentID: "helper",
      title: "Find references",
    });
    f.add({ ...base, id: "preview", title: "Idle preview" });
    f.add({
      ...base,
      id: "blocked",
      title: "Needs answer",
      attention: { ...base.attention, questions: 1 },
    });
    f.add({ ...base, id: "finished", title: "Unseen finish" });
    f.update("otk", { status: "busy" });
    f.update("finished", { status: "busy" });
    f.update("finished", { status: "idle" });
    const task = await c.rpc<TaskRecord>("tasks.create", {
      directory: base.directory,
      name: "Execution",
      sessions: ["otk"],
    });
    await b.goto(f.url);
    await openSession(b, "helper");
    await b.poll("location.hash==='#/local/otk/helper'");
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-session-group')].map(e=>({title:e.getAttribute('aria-label'),ids:[...e.querySelectorAll('[data-session]')].map(e=>e.dataset.session)}))",
      ),
      [
        { title: "Execution", ids: ["otk", "helper", "nested"] },
        { title: "Not in a task", ids: ["preview", "blocked", "finished"] },
      ],
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-session=nested]').closest('li').dataset.depth",
      ),
      "2",
    );
    for (
      const [id, state] of [["otk", "working"], ["blocked", "blocked"], [
        "finished",
        "finished",
      ]]
    ) {
      assert(
        await b.evaluate(
          `!!document.querySelector('[data-session=${id}] .otk-status-light[data-state=${state}]')`,
        ),
      );
    }
    const alignment = await b.evaluate<number[]>(
      "[...document.querySelectorAll('.otk-session-row')].map(e=>{const a=e.querySelector('.otk-status-light').getBoundingClientRect(),b=e.querySelector('.otk-row-title').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)})",
    );
    assert(alignment.every((n) => n < .5));
    await b.fill("input[type=search]", "references");
    await b.poll(
      "document.querySelectorAll('[data-session]').length===3 && !!document.querySelector('[data-session=nested]')",
    );
    await b.fill("input[type=search]", "no such title");
    await b.poll(
      "document.querySelector('.otk-project-sessions').textContent.includes('No matching sessions')",
    );
    await b.fill("input[type=search]", "");
    await b.click("[data-session=preview]");
    await b.poll(
      "document.querySelector('[data-tab=preview]')?.closest('.otk-tab').dataset.preview==='true' && document.querySelector('.otk-messages').textContent.includes('Transcript for preview')",
    );
    await b.type("textarea[name=prompt]", "Keep this draft");
    await b.click("[data-session=blocked]");
    await b.poll("location.hash.endsWith('/blocked')");
    await b.click("[data-session=preview]");
    await b.poll("location.hash.endsWith('/preview')");
    assertEquals(
      await b.evaluate("document.querySelector('textarea[name=prompt]').value"),
      "Keep this draft",
    );
    assertEquals(await b.evaluate("location.hash"), "#/local/preview");
    await b.fill("textarea[name=prompt]", "");
    await b.click("[data-session=preview]", 2);
    await b.poll(
      "[...document.querySelectorAll('.otk-tab[data-kind=task]')].some(e=>e.textContent.includes('Idle preview'))",
    );
    assertEquals((await c.rpc<TaskRecord[]>("tasks.list", {})).length, 2);
    await b.click("[data-session=nested]");
    await b.poll(
      `location.hash==='#/local/otk/nested' && document.querySelector('[data-tab="${task.id}"]')?.getAttribute('aria-selected')==='true' && document.querySelector('.otk-messages').textContent.includes('Transcript for nested')`,
    );
    await b.reload();
    await b.poll(
      "document.querySelector('[data-session=nested]')?.getAttribute('aria-current')==='page'",
    );
    assertEquals(b.errors, []);
  } finally {
    await Deno.writeTextFile(
      join(root, "sessions-state.json"),
      JSON.stringify(
        {
          state: await b.evaluate("document.documentElement.outerHTML"),
          errors: b.errors,
        },
        null,
        2,
      ),
    );
    console.info("Sessions browser evidence:", root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
});
