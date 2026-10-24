// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { Preferences, TaskRecord } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { menuReady } from "../support/menu.ts";

const menu = ':popover-open [role="menu"][aria-label="Context menu"]';
const app = ["New session", "Open command palette", "Display preferences"];
const session = ["Pin as task", "Copy session title", "Close session"];
const areas = {
  projects: ".otk-inbox-scroll",
  panel: ".otk-panel-content",
  transcript: ".otk-messages",
  composer: ".otk-prompt-actions",
};
async function groups(b: Cdp) {
  await menuReady(b, menu);
  return await b.evaluate<string[][]>(
    `[...document.querySelectorAll('${menu} > [role=group]')].map(group=>[...group.querySelectorAll('button')].map(item=>item.textContent))`,
  );
}
async function dismiss(b: Cdp) {
  await b.key("Escape");
  await b.poll(`!document.querySelector('${menu}')`);
}
async function pick(b: Cdp, title: string) {
  const point = await b.evaluate<{ x: number; y: number }>(
    `(()=>{const item=[...document.querySelectorAll('${menu} button')].find(item=>item.textContent===${
      JSON.stringify(title)
    });if(!item)throw Error('Missing action');const r=item.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await b.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
}
async function rightClick(
  b: Cdp,
  selector: string,
  empty = true,
  capture?: string,
) {
  const point = await b.evaluate<{ x: number; y: number }>(`(async()=>{
    const el=document.querySelector(${
    JSON.stringify(selector)
  });el.scrollIntoView({block:'nearest',behavior:'instant'});
    await new Promise(requestAnimationFrame);const r=el.getBoundingClientRect();
    if(!${empty})return {x:r.x+r.width/2,y:r.y+r.height/2};
    for(const y of [r.bottom-12,r.y+r.height/2,r.y+12])for(let x=r.x+8;x<r.right-4;x+=16){
      const hit=document.elementFromPoint(x,y);
      if(hit&&el.contains(hit)&&!hit.closest('[data-message],[data-project],[data-session],input,textarea,button,a,img'))return {x,y};
    }throw Error('No empty area point: '+${JSON.stringify(selector)});
  })()`);
  if (capture) {
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await b.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    await b.screenshot(`${capture}-before.png`);
  }
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
  const geometry = await b.evaluate<{ inside: boolean; rows: number[] }>(
    `(()=>{const panel=document.querySelector('${menu}').closest('.otk-surface'),r=panel.getBoundingClientRect();return {inside:r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth+.5&&r.bottom<=innerHeight+.5,rows:[...panel.querySelectorAll('[role=menuitem]')].map(el=>el.getBoundingClientRect().height)}})()`,
  );
  assert(geometry.inside, JSON.stringify(geometry));
  assert(
    geometry.rows.every((height) => height === 28),
    JSON.stringify(geometry),
  );
  if (capture) {
    await b.screenshot(`${capture}.png`);
    await Deno.writeTextFile(
      `${capture}.json`,
      JSON.stringify({ selector, point, geometry, groups: await groups(b) }),
    );
  }
}

test("C3 session menus omit current-place no-ops while background Open and task promotion still act", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    client = new WsClient(f.url);
  await client.connect();
  try {
    f.add({
      ...f.entries[0],
      id: "second",
      title: "Background",
      status: "busy",
    });
    await b.goto(f.url);
    await openSession(b, "otk");
    for (
      const selector of [
        ".otk-user-bubble",
        ".otk-messages",
        '[data-tab="otk"]',
        '[data-crumb="otk"]',
        '[data-session="otk"]',
      ]
    ) {
      await rightClick(b, selector, selector === ".otk-messages");
      const labels = (await groups(b)).flat();
      assert(!labels.includes("Open"), `${selector}: ${labels}`);
      assert(labels.includes("Pin as task"));
      await dismiss(b);
    }
    for (const selector of ['[data-tab="second"]', '[data-session="second"]']) {
      await rightClick(b, selector, false);
      assert((await groups(b)).flat().includes("Open"));
      await dismiss(b);
    }
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await rightClick(
        b,
        ".otk-user-bubble",
        false,
        Deno.env.get("OTK_CONTEXT_SCREENSHOTS")
          ? join(root, `C3-${theme}-session-menu-message`)
          : undefined,
      );
      assertEquals(await groups(b), [["Copy prompt"], [
        "Pin as task",
        "Copy session title",
        "Close session",
      ]]);
      await dismiss(b);
    }
    await rightClick(b, ".otk-messages");
    await pick(b, "Pin as task");
    await b.poll(`!!document.querySelector('.otk-tab[data-kind=task]')`);
    const tasks = await client.rpc<TaskRecord[]>("tasks.list", {
      directory: f.entries[0].directory,
    });
    assertEquals(tasks.length, 1);
    assert(tasks[0].sessions.includes("otk"));
    for (
      const selector of [
        ".otk-user-bubble",
        ".otk-messages",
        '[data-crumb="otk"]',
        '[data-session="otk"]',
      ]
    ) {
      await rightClick(b, selector, selector === ".otk-messages");
      const labels = (await groups(b)).flat();
      assert(
        !labels.some((label) =>
          ["Open", "Open as task", "Pin as task"].includes(label)
        ),
        `${selector}: ${labels}`,
      );
      await dismiss(b);
    }
    await rightClick(b, '[data-session="second"]', false);
    await pick(b, "Open");
    await b.poll(
      `location.hash.endsWith('/second') && !!document.querySelector('[data-message="second-message"]')`,
    );
    await rightClick(b, '[data-session="otk"]', false);
    const background = (await groups(b)).flat();
    assert(background.includes("Open"));
    assert(background.includes("Open as task"));
    assert(!background.includes("Pin as task"));
    await pick(b, "Open as task");
    await b.poll(
      `location.hash.endsWith('/otk') && document.querySelector('[data-tab="${
        tasks[0].id
      }"]').getAttribute('aria-selected')==='true'`,
    );
    assertEquals(
      (await client.rpc<TaskRecord[]>("tasks.list", {
        directory: f.entries[0].directory,
      })).length,
      1,
    );
    assertEquals(b.errors, []);
    console.info("C3 session-menu screenshot root", root);
  } finally {
    await client.close();
    await b.close();
    await f.app.stop();
  }
});

test("C3 areas: empty regions, inner groups and shared control commands reach their consumers", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    client = new WsClient(f.url);
  await client.connect();
  try {
    for (const entry of [f.entries[0], f.entries[3]]) {
      await client.rpc("projects.visit", {
        directory: entry.directory,
        active: true,
      });
    }
    await client.rpc("projects.inactive", {
      directory: f.entries[3].directory,
      inactive: true,
    });
    await b.goto(f.url);
    await openSession(b, "otk");
    await b.send("Browser.grantPermissions", {
      origin: f.url,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    const projects = [
      "Add project",
      "Show inactive projects",
      "Collapse projects",
    ];
    await rightClick(b, areas.projects);
    assertEquals(await groups(b), [projects, app]);
    await pick(b, "Show inactive projects");
    await b.poll(
      `!!document.querySelector('.otk-inactive-projects [data-project-sessions~="luch"]')`,
    );
    await rightClick(b, areas.projects);
    assertEquals(await groups(b), [[
      "Add project",
      "Hide inactive projects",
      "Collapse projects",
    ], app]);
    await pick(b, "Hide inactive projects");
    await b.poll(`!document.querySelector('.otk-inactive-projects')`);
    if (Deno.env.get("OTK_CONTEXT_SCREENSHOTS")) {
      for (const theme of ["otk-dark", "otk-light"]) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
        await rightClick(
          b,
          areas.projects,
          true,
          join(root, `C3-${theme}-projects-inactive-closed`),
        );
        assertEquals(await groups(b), [projects, app]);
        await pick(b, "Show inactive projects");
        await b.poll(`!!document.querySelector('.otk-inactive-projects')`);
        await rightClick(
          b,
          areas.projects,
          true,
          join(root, `C3-${theme}-projects-inactive-open`),
        );
        await pick(b, "Hide inactive projects");
        await b.poll(`!document.querySelector('.otk-inactive-projects')`);
        await rightClick(
          b,
          '[data-project-sessions~="otk"] .otk-project-open',
          false,
          join(root, `C3-${theme}-project-row`),
        );
        assertEquals(await groups(b), [["Mark inactive"], projects]);
        await dismiss(b);
        await rightClick(
          b,
          ".otk-user-bubble",
          false,
          join(root, `C3-${theme}-message`),
        );
        assertEquals(await groups(b), [["Copy prompt"], session]);
        await dismiss(b);
      }
    }
    await rightClick(
      b,
      '[data-project-sessions~="otk"] .otk-project-open',
      false,
    );
    assertEquals(await groups(b), [["Mark inactive"], projects]);
    await dismiss(b);
    await rightClick(b, areas.projects);
    await pick(b, "Add project");
    await b.poll(
      `!!document.querySelector('dialog[aria-label="Add project"][open] input[name=directory]')`,
    );
    await b.poll(
      `!!document.querySelector('dialog [aria-label="Scanned projects"]')`,
    );
    await b.key("Escape");
    await b.poll(`!document.querySelector('dialog[open]')`);
    await rightClick(b, areas.projects);
    await pick(b, "Collapse projects");
    await b.poll(
      `document.querySelector('.otk-project-inbox').dataset.collapsed==='true'`,
    );
    assertEquals(
      (await client.rpc<Preferences>("prefs.get", {})).shellLayout
        .leftCollapsed,
      true,
    );
    await b.click(".otk-corner-left");
    await b.poll(
      `document.querySelector('.otk-project-inbox').dataset.collapsed==='false'`,
    );
    await rightClick(b, areas.panel);
    assertEquals(await groups(b), [[
      "New session",
      "Find a session",
      "Collapse right panel",
    ], app.slice(1)]);
    await pick(b, "Find a session");
    await b.poll(
      `document.activeElement===document.querySelector('input[aria-label="Search sessions by title"]')`,
    );
    await b.type('input[aria-label="Search sessions by title"]', "not-present");
    await b.poll(`!document.querySelector('.otk-session-row')`);
    await b.fill('input[aria-label="Search sessions by title"]', "");
    await b.poll(`!!document.querySelector('.otk-session-row')`);
    await rightClick(b, areas.panel);
    await pick(b, "Collapse right panel");
    await b.poll(
      `document.querySelector('.otk-app').dataset.rightCollapsed==='true'`,
    );
    assertEquals(
      (await client.rpc<Preferences>("prefs.get", {})).shellLayout
        .rightCollapsed,
      true,
    );
    await b.click(".otk-corner-right");
    await b.poll(
      `document.querySelector('.otk-app').dataset.rightCollapsed==='false'`,
    );
    const before = f.entries.length;
    await rightClick(b, areas.panel);
    await pick(b, "New session");
    await b.poll(
      `!location.hash.endsWith('/otk') && !!document.querySelector('textarea[name=prompt]')`,
    );
    assertEquals(f.entries.length, before + 1);
    await openSession(b, "otk");
    await rightClick(b, areas.transcript);
    assertEquals(await groups(b), [session, app]);
    await pick(b, "Copy session title");
    await b.poll(
      `navigator.clipboard.readText().then(text=>text==='Execution')`,
    );
    await rightClick(b, ".otk-user-bubble", false);
    assertEquals(await groups(b), [["Copy prompt"], session]);
    await pick(b, "Copy prompt");
    await b.poll(
      `navigator.clipboard.readText().then(text=>text==='Transcript for otk')`,
    );
    await b.fill("textarea[name=prompt]", "Keep this prompt");
    await rightClick(b, areas.composer);
    assertEquals(await groups(b), [["Edit prompt", "Attach files"], app]);
    await pick(b, "Edit prompt");
    await b.poll(
      `!!document.querySelector('dialog[aria-label="Edit prompt"][open] textarea')`,
    );
    assertEquals(
      await b.evaluate(`document.querySelector('dialog textarea').value`),
      "Keep this prompt",
    );
    await b.key("Escape");
    await b.poll(`!document.querySelector('dialog[open]')`);
    assertEquals(
      await b.evaluate(`document.querySelector('textarea[name=prompt]').value`),
      "Keep this prompt",
    );
    const attachment = join(root, "area-attachment.txt");
    await Deno.writeTextFile(attachment, "Area attachment bytes");
    await b.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await rightClick(b, areas.composer);
    await pick(b, "Attach files");
    await b.poll(`!document.querySelector('${menu}')`);
    assert(b.events.some((event) => event.method === "Page.fileChooserOpened"));
    await b.send("DOM.setFileInputFiles", {
      files: [attachment],
      backendNodeId: b.events.findLast((event) =>
        event.method === "Page.fileChooserOpened"
      )!.params.backendNodeId,
    });
    await b.poll(
      `!!document.querySelector('.otk-prompt-chip button[title="area-attachment.txt"]') && !document.querySelector('.otk-prompt-chip').textContent.includes('reading')`,
    );
    await openSession(b, f.entries.at(-1)!.id);
    await rightClick(b, '[data-session="otk"]', false);
    await pick(b, "Open");
    await b.poll(
      `location.hash.endsWith('/otk') && !!document.querySelector('[data-message="otk-message"]')`,
    );
    await rightClick(b, areas.transcript);
    await pick(b, "Pin as task");
    await b.poll(`!!document.querySelector('.otk-tab[data-kind=task]')`);
    assert(
      (await client.rpc<TaskRecord[]>("tasks.list", {
        directory: f.entries[0].directory,
      })).some((task) => task.sessions.includes("otk")),
    );
    assertEquals(b.errors, []);
    console.info("C3 external screenshot root", root);
  } finally {
    await client.close();
    await b.close();
    await f.app.stop();
  }
});

test("C3 stock areas: picker and approval commands, Activity panel and Dark/Linen menu geometry", async () => {
  const f = await browserFixture({ bash: "allow" });
  let client: WsClient | undefined;
  try {
    const created = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Area commands" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await openSession(b, created.id);
    await b.poll(
      `!!document.querySelector('.otk-agent-picker > button') && !!document.querySelector('.otk-model-picker > button')`,
    );
    await b.poll(
      `document.querySelector('.otk-composer-model-name')?.textContent==='scripted'`,
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (const [name, selector] of Object.entries(areas)) {
        await rightClick(
          b,
          selector,
          true,
          Deno.env.get("OTK_CONTEXT_SCREENSHOTS")
            ? join(f.oc.root, `C3-${theme}-${name}`)
            : undefined,
        );
        const expected = name === "projects"
          ? [["Add project", "Collapse projects"], app]
          : name === "panel"
          ? [
            ["New session", "Find a session", "Collapse right panel"],
            app.slice(1),
          ]
          : name === "transcript"
          ? [[
            "Pin as task",
            "Turn auto-approve on",
            "Copy session title",
            "Close session",
          ], app]
          : [
            ["Choose agent", "Choose model", "Edit prompt", "Attach files"],
            app,
          ];
        assertEquals(await groups(b), expected);
        await dismiss(b);
      }
    }
    for (const kind of ["agent", "model"]) {
      await rightClick(b, areas.composer);
      await pick(b, `Choose ${kind}`);
      await b.poll(
        `!!document.querySelector('.otk-${kind}-picker .otk-popover-panel:popover-open .otk-picker-row')`,
      );
      assert(
        await b.evaluate(
          `document.querySelector('.otk-${kind}-picker :popover-open').contains(document.activeElement)`,
        ),
      );
      await b.key("Escape");
      await b.poll(
        `!document.querySelector('.otk-${kind}-picker :popover-open')`,
      );
    }
    await rightClick(b, areas.transcript);
    await pick(b, "Turn auto-approve on");
    await b.poll(
      `!!document.querySelector('.otk-crumb .otk-auto-mark') || !!document.querySelector('[data-crumb] .otk-auto-mark')`,
    );
    await rightClick(b, areas.transcript);
    assert((await groups(b))[0].includes("Turn auto-approve off"));
    await pick(b, "Turn auto-approve off");
    await b.poll(`!document.querySelector('[data-crumb] .otk-auto-mark')`);
    await b.click('[data-panel-view="activity"]');
    await b.poll(
      `document.querySelector('#otk-panel-content').getAttribute('aria-label')==='Activity'`,
    );
    await rightClick(b, areas.panel);
    assertEquals(await groups(b), [
      ["New session", "Collapse right panel"],
      app.slice(1),
    ]);
    await pick(b, "Collapse right panel");
    await b.poll(
      `document.querySelector('.otk-app').dataset.rightCollapsed==='true'`,
    );
    assertEquals(b.errors, []);
    console.info("C3 screenshot root", f.oc.root);
  } finally {
    await client?.close();
    await f.stop();
  }
});
