// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type {
  AssistantMessage,
  FileDiff,
  Message,
  TaskRecord,
} from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { menuReady } from "../support/menu.ts";

const menu = ':popover-open [role="menu"][aria-label="Context menu"]';
const panelArea = ["New session", "Find a session", "Collapse right panel"];
const transcriptArea = ["Pin as task", "Copy session title", "Close session"];
const captureOrigins = new WeakMap<
  Cdp,
  { selector: string; theme: string; before: string }
>();
async function rightClick(b: Cdp, selector: string) {
  const point = await b.evaluate<{ x: number; y: number }>(`(async()=>{
    const el=document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({block:'center',behavior:'instant'});
    await new Promise(requestAnimationFrame);
    const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  if (Deno.env.get("OTK_CONTEXT_SCREENSHOTS")) {
    const before = await b.send("Page.captureScreenshot", { format: "png" });
    captureOrigins.set(b, {
      selector,
      theme: await b.evaluate<string>(
        "document.documentElement.dataset.otkTheme",
      ),
      before: before.data as string,
    });
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
}
async function labels(b: Cdp) {
  await menuReady(b, menu);
  return await b.evaluate<string[]>(
    `[...document.querySelectorAll('${menu} button')].map(el=>el.textContent)`,
  );
}
async function invoke(b: Cdp, label: string) {
  const point = await b.evaluate<{ x: number; y: number }>(
    `(()=>{const el=[...document.querySelectorAll('${menu} button')].find(el=>el.textContent===${
      JSON.stringify(label)
    }); if(!el) throw new Error('Missing menu item'); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
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
async function dismiss(b: Cdp) {
  await b.key("Escape");
  await b.poll(`!document.querySelector('${menu}')`);
}
async function clipboard(b: Cdp, value: string) {
  await b.poll(
    `navigator.clipboard.readText().then(text=>text===${
      JSON.stringify(value)
    })`,
  );
}
async function capture(b: Cdp, root: string, name: string) {
  if (Deno.env.get("OTK_CONTEXT_SCREENSHOTS")) {
    if (await b.evaluate(`!!document.querySelector('${menu}')`)) {
      let origin = captureOrigins.get(b)!;
      if (
        origin.theme !==
          await b.evaluate("document.documentElement.dataset.otkTheme")
      ) {
        await dismiss(b);
        await rightClick(b, origin.selector);
        origin = captureOrigins.get(b)!;
      }
      await Deno.writeFile(
        `${root}/C2-${name}-before.png`,
        Uint8Array.from(atob(origin.before), (c) => c.charCodeAt(0)),
      );
      await Deno.writeTextFile(
        `${root}/C2-${name}.json`,
        JSON.stringify(
          await b.evaluate(`(() => {
        const r=document.querySelector('${menu}').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};
      })()`),
        ),
      );
    }
    await b.screenshot(`${root}/C2-${name}.png`);
  }
}
async function grant(b: Cdp, url: string) {
  await b.send("Browser.grantPermissions", {
    origin: url,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
}

test("C2 session targets: tabs, chips, rows, task actions and project menu have captured effects", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    client = new WsClient(f.url);
  await client.connect();
  try {
    await client.rpc("projects.visit", {
      directory: f.entries[0].directory,
      active: true,
    });
    f.add({ ...f.entries[0], id: "second", title: "Second session" });
    await b.goto(f.url);
    await openSession(b, "otk");
    await grant(b, f.url);
    const spare = await client.rpc<TaskRecord>("tasks.create", {
      directory: f.entries[0].directory,
      name: "Review",
    });
    const task = await client.rpc<TaskRecord>("tasks.create", {
      directory: f.entries[0].directory,
      name: "Delivery",
    });
    await b.poll(`!!document.querySelector('[data-tab="${task.id}"]')`);
    const expected = [
      "Pin as task",
      "Add to task: Review",
      "Add to task: Delivery",
      "Copy session title",
      "Close session",
    ];
    for (
      const [name, selector] of [
        ["tab", '[data-tab="otk"]'],
        ["chip", '[data-crumb="otk"]'],
        ["session-row", '[data-session="otk"]'],
      ]
    ) {
      await rightClick(b, selector);
      const rows = name === "session-row"
        ? [...expected, ...panelArea]
        : expected;
      assertEquals(await labels(b), rows);
      assertEquals(
        await b.evaluate(
          `[...document.querySelectorAll('${menu} button')].filter(el=>el.textContent.startsWith('Add to task:')).map(el=>el.dataset.contextCommand)`,
        ),
        ["task.add", "task.add"],
      );
      await b.poll(
        `document.activeElement===document.querySelector('${menu}')`,
      );
      assertEquals(
        await b.evaluate(
          `getComputedStyle(document.activeElement).outlineStyle`,
        ),
        "none",
      );
      assertEquals(
        await b.evaluate(
          `[...document.querySelectorAll('${menu} button')].map(el=>el.getBoundingClientRect().height)`,
        ),
        rows.map(() => 28),
      );
      for (const theme of ["otk-dark", "otk-light"]) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
        await capture(b, root, `${theme}-${name}`);
      }
      await invoke(b, "Copy session title");
      await clipboard(b, "Execution");
      await b.poll(`!document.querySelector('${menu}')`);
    }
    await b.evaluate(`document.querySelector('[data-tab="otk"]').focus()`);
    for (const key of ["ContextMenu", "F10"]) {
      await b.key(key, key === "F10" ? 8 : 0);
      await b.poll(
        `document.activeElement?.textContent==='Pin as task' && !!document.activeElement?.closest('${menu}')`,
      );
      await b.key("End");
      await b.poll(
        `document.activeElement?.textContent==='Close session'`,
      );
      await dismiss(b);
      await b.poll(
        `document.activeElement===document.querySelector('[data-tab="otk"]')`,
      );
    }
    // Opening a background row must use that row, not the currently viewed session.
    await rightClick(b, '[data-session="second"]');
    await invoke(b, "Open");
    await b.poll(
      `location.hash.endsWith('/second') && !!document.querySelector('[data-message="second-message"]')`,
    );
    await rightClick(b, '[data-session="otk"]');
    await invoke(b, "Add to task: Delivery");
    await b.poll(
      `!!document.querySelector('[data-session-group="${task.id}"] [data-session="otk"]')`,
    );
    await rightClick(b, '[data-session="otk"]');
    assertEquals(await labels(b), [
      "Open",
      "Open as task",
      "Add to task: Review",
      "Copy session title",
      "Close session",
      ...panelArea,
    ]);
    await invoke(b, "Open as task");
    await b.poll(
      `location.hash.endsWith('/otk') && document.querySelector('[data-tab="${task.id}"]').getAttribute('aria-selected')==='true'`,
    );
    // Pin the other session through its chip and observe persisted task membership.
    await rightClick(b, '[data-session="second"]');
    await invoke(b, "Open");
    await b.poll(`!!document.querySelector('[data-crumb="second"]')`);
    // Task grouping is serving-sidecar metadata, independent of the native link.
    f.app.connections.connection("reconnecting");
    await b.poll(
      `document.querySelector('.otk-server-status')?.getAttribute('aria-label').includes('agent service reconnecting')`,
    );
    await rightClick(b, '[data-crumb="second"]');
    assert((await labels(b)).includes("Pin as task"));
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, root, `${theme}-offline-pin-menu`);
    }
    await invoke(b, "Pin as task");
    await b.poll(
      `document.querySelectorAll('.otk-tab[data-kind="task"]').length===3`,
    );
    const saved = await client.rpc<TaskRecord[]>("tasks.list", {
      directory: f.entries[0].directory,
    });
    assert(
      saved.some((t) =>
        t.name === "Second session" && t.sessions.includes("second")
      ),
    );
    await client.rpc("tasks.close", { id: spare.id });
    f.app.connections.connection("connected");
    await b.poll(
      `document.querySelector('.otk-server-status')?.getAttribute('aria-label').includes('agent service connected')`,
    );
    await rightClick(b, `[data-tab="${task.id}"]`);
    assertEquals(await labels(b), ["Rename task", "Close task"]);
    assertEquals(
      await b.evaluate(
        `document.querySelectorAll('${menu} [role=separator]').length`,
      ),
      1,
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, root, `${theme}-task`);
    }
    await invoke(b, "Rename task");
    await b.poll(
      `!!document.querySelector('dialog[aria-label="Rename task"][open]')`,
    );
    await b.fill('input[name="taskName"]', "Delivered");
    await b.click('dialog button[type="submit"]');
    await b.poll(
      `document.querySelector('[data-tab="${task.id}"]')?.getAttribute('aria-label')==='Delivered'`,
    );
    assertEquals(
      (await client.rpc<TaskRecord[]>("tasks.list", {
        directory: f.entries[0].directory,
      })).find((t) => t.id === task.id)?.name,
      "Delivered",
    );
    await rightClick(b, `[data-tab="${task.id}"]`);
    await invoke(b, "Close task");
    await b.poll(`!document.querySelector('[data-tab="${task.id}"]')`);
    assert(
      !(await client.rpc<TaskRecord[]>("tasks.list", {
        directory: f.entries[0].directory,
      })).some((t) => t.id === task.id),
    );
    assertEquals(
      await b.evaluate(`location.hash.endsWith('/second')`),
      true,
      "Closing another task must preserve the selected session",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await rightClick(b, '[data-project-sessions~="otk"] .otk-project-open');
      assertEquals(await labels(b), [
        "Mark inactive",
        "Add project",
        "Collapse projects",
      ]);
      await capture(b, root, `${theme}-project`);
      await dismiss(b);
    }
    await rightClick(b, '[data-project-sessions~="otk"] .otk-project-open');
    await invoke(b, "Mark inactive");
    await b.click(".otk-inactive-toggle");
    await b.poll(
      `!!document.querySelector('[data-project-sessions~="otk"][data-inactive="true"]')`,
    );
    await rightClick(b, '[data-project-sessions~="otk"] .otk-project-open');
    assertEquals(await labels(b), [
      "Mark active",
      "Add project",
      "Hide inactive projects",
      "Collapse projects",
    ]);
    await invoke(b, "Mark active");
    await b.poll(
      `!!document.querySelector('[data-project-sessions~="otk"][data-inactive="false"]')`,
    );
    assertEquals(b.errors, []);
    console.info("C2 screenshot root", root);
  } finally {
    await client.close();
    await b.close();
    await f.app.stop();
  }
});

const file: FileDiff = {
  path: "/project/main.ts",
  status: "modified",
  additions: 2,
  deletions: 2,
  hunks: [{
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [
      { kind: "context", text: "// keep", oldNo: 1, newNo: 1 },
      { kind: "del", text: "const oldValue = 1;", oldNo: 2 },
      { kind: "add", text: "const newValue = 2;", newNo: 2 },
    ],
  }, {
    oldStart: 10,
    oldLines: 1,
    newStart: 10,
    newLines: 1,
    lines: [
      { kind: "del", text: "const previous = true;", oldNo: 10 },
      { kind: "add", text: "const current = true;", newNo: 10 },
    ],
  }],
};
const reply: AssistantMessage = {
  id: "reply",
  sessionID: "otk",
  replyTo: "prompt",
  role: "assistant",
  agent: "build",
  model: { provider: "fixture", model: "model" },
  time: { created: 2, completed: 3 },
  tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
  interrupted: false,
  parts: [
    {
      id: "answer",
      kind: "text",
      synthetic: false,
      blocks: [
        { b: "paragraph", inline: [{ i: "text", text: "Reply source" }] },
        { b: "code", text: "const answer = 42;\n", lang: "typescript" },
      ],
    },
    {
      id: "bash",
      kind: "tool",
      call: {
        tool: "bash",
        callID: "bash",
        command: "printf context-output",
        output: "context-output",
        status: "completed",
        awaitingPermission: false,
        time: { start: 2, end: 3 },
      },
    },
    {
      id: "read",
      kind: "tool",
      call: {
        tool: "read",
        callID: "read",
        path: "/project/source.txt",
        loaded: [],
        output: "Read output",
        status: "completed",
        awaitingPermission: false,
        time: { start: 2, end: 3 },
      },
    },
    {
      id: "edit",
      kind: "tool",
      call: {
        tool: "edit",
        callID: "edit",
        path: file.path,
        files: [file],
        output: "",
        diagnostics: [],
        status: "completed",
        awaitingPermission: false,
        time: { start: 2, end: 3 },
      },
    },
    {
      id: "patch",
      kind: "tool",
      call: {
        tool: "patch",
        callID: "patch",
        files: [file, { ...file, path: "/project/other.ts" }],
        output: "",
        status: "completed",
        awaitingPermission: false,
        time: { start: 2, end: 3 },
      },
    },
  ],
};
test("C2 shared reply contributions stay constant across N real messages and external features receive identity", async () => {
  const root = await fixture(), assets = join(root, "context-dist");
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "tests/support/context-consumer/vite.config.ts",
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
    b = await Cdp.launch(root);
  try {
    await b.goto(f.url);
    await b.click("#mount-transcript");
    await b.poll(`document.querySelectorAll('[data-message]').length===1`);
    const initial = await b.evaluate<number>(
      "Number(document.querySelector('#context-command-count').textContent)",
    );
    await rightClick(b, '[data-message="probe-reply-0"] .otk-text p');
    assertEquals(await labels(b), ["Copy reply", "Inspect reply identity"]);
    await invoke(b, "Inspect reply identity");
    await b.poll(
      `document.querySelector('#reply-identity').textContent.includes('probe-reply-0')`,
    );
    assertEquals(
      await b.evaluate(
        "JSON.parse(document.querySelector('#reply-identity').textContent)",
      ),
      {
        sidecarId: "probe-sidecar",
        sessionID: "probe-session",
        messageID: "probe-reply-0",
        lastID: "probe-reply-0",
        completed: true,
        queued: false,
        directory: "/probe",
        text: "Reply 0",
      },
    );
    await b.click("#grow-transcript");
    await b.poll(`document.querySelectorAll('[data-message]').length===40`);
    assertEquals(
      await b.evaluate(
        "Number(document.querySelector('#context-command-count').textContent)",
      ),
      initial,
    );
    await rightClick(b, '[data-message="probe-reply-39"] .otk-text p');
    await invoke(b, "Inspect reply identity");
    await b.poll(
      `document.querySelector('#reply-identity').textContent.includes('probe-reply-39')`,
    );
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await f.app.stop();
  }
});

test("C2 stale task and phantom menus follow captured identities across session switches", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root),
    client = new WsClient(f.url);
  await client.connect();
  try {
    await b.goto(f.url);
    await openSession(b, "otk");
    const task = await client.rpc<TaskRecord>("tasks.create", {
      directory: f.entries[0].directory,
      name: "Captured task",
    });
    await b.poll(`!!document.querySelector('[data-tab="${task.id}"]')`);
    // Leave a genuine unrelated text selection in place while targeting a tab.
    await b.evaluate(
      `(()=>{const text=document.querySelector('.otk-user-bubble .otk-text'); const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range)})()`,
    );
    await rightClick(b, `[data-tab="${task.id}"]`);
    assertEquals(await labels(b), ["Rename task", "Close task"]);
    // Programmatic navigation preserves the open menu, exposing stale-target work.
    await b.evaluate(
      `location.hash=location.hash.slice(0,location.hash.lastIndexOf('/')+1)+'atmosphera'`,
    );
    await b.poll(
      `location.hash.endsWith('/atmosphera') && !document.querySelector('${menu}')`,
    );
    assert(
      (await client.rpc<TaskRecord[]>("tasks.list", {
        directory: f.entries[0].directory,
      })).some((value) => value.id === task.id),
    );
    assertEquals(
      await b.evaluate("!!document.querySelector('dialog[open]')"),
      false,
    );
    await b.evaluate(
      `location.hash=location.hash.slice(0,location.hash.lastIndexOf('/')+1)+'otk'`,
    );
    await b.poll(`location.hash.endsWith('/otk')`);
    await rightClick(b, '[data-tab="otk"]');
    await b.evaluate(
      `location.hash=location.hash.slice(0,location.hash.lastIndexOf('/')+1)+'atmosphera'`,
    );
    await b.poll(`location.hash.endsWith('/atmosphera')`);
    // Global session commands remain meaningful: copy targets the original session.
    await grant(b, f.url);
    await b.poll(`!!document.querySelector('${menu}')`);
    await invoke(b, "Copy session title");
    await clipboard(b, "Execution");
    assertEquals(
      await b.evaluate("location.hash.endsWith('/atmosphera')"),
      true,
    );
    assertEquals(b.errors, []);
  } finally {
    await client.close();
    await b.close();
    await f.app.stop();
  }
});

test("C2 project dots share the row projection and report failures without rejected event handlers", async () => {
  const root = await fixture(), assets = join(root, "context-dist");
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "tests/support/context-consumer/vite.config.ts",
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
    b = await Cdp.launch(root);
  try {
    await b.goto(f.url);
    await b.click("#mount-project-probe");
    await b.poll(
      `!!document.querySelector('#project-probe .otk-project-open')`,
    );
    await rightClick(b, "#project-probe .otk-project-open");
    const expected = await labels(b);
    assertEquals(expected, ["Mark inactive"]);
    await dismiss(b);
    await b.evaluate(
      `document.querySelector('#project-probe .otk-project-menu button').focus()`,
    );
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
    const dots =
      ':popover-open [role="menu"][aria-label="Project menu for probe"]';
    await b.poll(`!!document.querySelector('${dots}')`);
    await b.poll(
      `document.querySelector('${dots} button')?.textContent==='Mark inactive' && document.activeElement===document.querySelector('${dots} button')`,
    );
    assertEquals(
      await b.evaluate(
        `[...document.querySelectorAll('${dots} button')].map(el=>el.textContent)`,
      ),
      expected,
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await b.evaluate(
        `document.querySelector('#${
          theme === "otk-dark" ? "dark" : "light"
        }').click()`,
      );
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, root, `${theme}-project-dots`);
    }
    await b.click(`${dots} button`);
    await b.poll(
      `document.querySelector('#project-probe .otk-project-error')?.textContent==='Project update failed'`,
    );
    await b.poll(
      `document.querySelector('${dots} button').hasAttribute('aria-describedby')`,
    );
    assertEquals(
      await b.evaluate(`!!document.querySelector('${dots} [role="alert"]')`),
      false,
    );
    assertEquals(
      await b.evaluate(
        `(()=>{const row=document.querySelector('#project-probe [data-project]').getBoundingClientRect(),action=document.querySelector('#project-probe .otk-project-open').getBoundingClientRect(),alert=document.querySelector('#project-probe .otk-project-error').getBoundingClientRect();return alert.top>=action.bottom && alert.bottom<=row.bottom && alert.left>=action.left && alert.right<=row.right})()`,
      ),
      true,
      "Row feedback flows below its action line within the row bounds",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await b.evaluate(
        `document.querySelector('#${
          theme === "otk-dark" ? "dark" : "light"
        }').click()`,
      );
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, root, `${theme}-project-dots-error`);
    }
    // Readiness changes remove the projected action while its menu remains open.
    await b.evaluate(`document.querySelector('#disconnect-project').click()`);
    await b.poll(`!document.querySelector('${dots}')`);
    assertEquals(b.errors, []);
    console.info("C2 project error screenshot root", root);
  } finally {
    await b.close();
    await f.app.stop();
  }
});

test("C2 content targets: prompt, whole reply, nested code/diff and feature-contributed tool sources", async () => {
  const root = await fixture();
  const prompt: Message = {
    id: "prompt",
    sessionID: "otk",
    role: "user",
    time: { created: 1 },
    parts: [{
      id: "input",
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "Prompt source" }],
      }],
    }],
  };
  const followup: AssistantMessage = {
    ...reply,
    id: "reply-followup",
    time: { created: 4, completed: 5 },
    parts: [{
      id: "followup-text",
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "Second reply step" }],
      }],
    }],
  };
  const f = await inboxBrowserFixture(root, [], {
      otk: [prompt, reply, followup],
    }),
    b = await Cdp.launch(root),
    client = new WsClient(f.url);
  await client.connect();
  try {
    await b.goto(f.url);
    await openSession(b, "otk");
    await grant(b, f.url);
    await b.poll(`!!document.querySelector('[data-message="reply"]')`);
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, root, `${theme}-content-before`);
      for (
        const [name, selector, expected, pick, copied] of [
          [
            "prompt",
            ".otk-user-bubble",
            ["Copy prompt"],
            "Copy prompt",
            "Prompt source",
          ],
          [
            "reply",
            '[data-message="reply"] .otk-text p',
            ["Copy reply"],
            "Copy reply",
            "Reply source\n\nconst answer = 42;\n\n\nSecond reply step",
          ],
          [
            "code",
            '[data-message="reply"] .otk-text .otk-code',
            ["Copy code", "Copy reply"],
            "Copy code",
            "const answer = 42;\n",
          ],
        ] as const
      ) {
        await rightClick(b, selector);
        assertEquals(await labels(b), [...expected, ...transcriptArea]);
        await capture(b, root, `${theme}-${name}`);
        await invoke(b, pick);
        await clipboard(b, copied);
      }
    }
    await b.poll(`!!document.querySelector('[data-tool="bash"]')`);
    await rightClick(b, '[data-tool="bash"] .otk-tool-toggle');
    assertEquals(await labels(b), [
      "Copy command",
      "Copy output",
      "Expand",
      "Copy reply",
      ...transcriptArea,
    ]);
    await invoke(b, "Copy command");
    await clipboard(b, "printf context-output");
    await rightClick(b, '[data-tool="bash"] .otk-tool-toggle');
    await invoke(b, "Expand");
    await b.poll(
      `document.querySelector('[data-tool="bash"] .otk-tool-toggle').getAttribute('aria-expanded')==='true'`,
    );
    await rightClick(b, '[data-tool="bash"] .otk-tool-toggle');
    assertEquals(await labels(b), [
      "Copy command",
      "Copy output",
      "Collapse",
      "Copy reply",
      ...transcriptArea,
    ]);
    await invoke(b, "Copy output");
    await clipboard(b, "context-output");
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await rightClick(b, '[data-tool="bash"] .otk-tool-toggle');
      await capture(b, root, `${theme}-tool`);
      await dismiss(b);
    }
    await rightClick(b, '[data-tool="bash"] .otk-tool-toggle');
    await invoke(b, "Collapse");
    await b.poll(
      `document.querySelector('[data-tool="bash"] .otk-tool-toggle').getAttribute('aria-expanded')==='false'`,
    );
    await rightClick(b, '[data-tool="read"] .otk-tool-toggle');
    assertEquals(await labels(b), [
      "Copy path",
      "Copy output",
      "Expand",
      "Copy reply",
      ...transcriptArea,
    ]);
    await invoke(b, "Copy path");
    await clipboard(b, "/project/source.txt");
    await rightClick(b, '[data-tool="edit"] .otk-tool-toggle');
    assertEquals(await labels(b), [
      "Copy path",
      "Expand",
      "Copy reply",
      ...transcriptArea,
    ]);
    await invoke(b, "Expand");
    await b.poll(
      `!document.querySelector('[data-tool="edit"] .otk-tool-body').hidden`,
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await rightClick(b, ".otk-diff .otk-diff-text");
      assertEquals(await labels(b), [
        "Copy code",
        "Copy path",
        "Collapse",
        ...transcriptArea,
      ]);
      await capture(b, root, `${theme}-diff`);
      await invoke(b, "Copy code");
      await clipboard(b, "// keep\nconst newValue = 2;");
    }
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await rightClick(
        b,
        '[data-tool="edit"] .otk-diff-content:nth-of-type(2) .otk-diff-text',
      );
      await capture(b, root, `${theme}-second-hunk`);
      await invoke(b, "Copy code");
      await clipboard(b, "const current = true;");
      await rightClick(b, '[data-tool="patch"] .otk-tool-toggle');
      assertEquals(await labels(b), [
        "Copy paths",
        "Expand",
        "Copy reply",
        ...transcriptArea,
      ]);
      await capture(b, root, `${theme}-multiple-paths`);
      await invoke(b, "Copy paths");
      await clipboard(b, "/project/main.ts\n/project/other.ts");
    }
    assertEquals(b.errors, []);
    console.info("C2 screenshot root", root);
  } finally {
    await client.close();
    await b.close();
    await f.app.stop();
  }
});

test("C2 stock capabilities: targeted auto-approve and reply usage menu reach their real consumers", async () => {
  const f = await browserFixture({ bash: "allow" });
  let client: WsClient | undefined;
  try {
    const first = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Viewed session" },
    });
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Context session" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await openSession(b, first.id);
    await rightClick(b, `[data-session="${other.id}"]`);
    assertEquals(await labels(b), [
      "Open",
      "Pin as task",
      "Rename",
      "Fork session",
      "Turn auto-approve on",
      "Copy session title",
      "Close session",
      "Delete",
      ...panelArea,
    ]);
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, f.oc.root, `${theme}-approval-on-menu`);
    }
    await invoke(b, "Turn auto-approve on");
    await b.poll(
      `!!document.querySelector('[data-session="${other.id}"] .otk-auto-mark') && !document.querySelector('[data-session="${first.id}"] .otk-auto-mark')`,
    );
    assertEquals(
      await b.evaluate(`location.hash.endsWith('/${first.id}')`),
      true,
    );
    await rightClick(b, `[data-session="${other.id}"]`);
    assert((await labels(b)).includes("Turn auto-approve off"));
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, f.oc.root, `${theme}-approval-off-menu`);
    }
    await invoke(b, "Turn auto-approve off");
    await b.poll(
      `!document.querySelector('[data-session="${other.id}"] .otk-auto-mark')`,
    );
    f.fake.queue({ chunks: ["Usage menu reply."] });
    await b.type('textarea[name="prompt"]', "Give a short reply");
    await b.key("Enter");
    await waitForReply(b, first.id, "Usage menu reply.");
    await b.poll(`!!document.querySelector('.otk-turn-usage > button')`);
    await rightClick(b, '[data-role="assistant"] .otk-text p');
    assertEquals(await labels(b), [
      "Copy reply",
      "Fork from here",
      "Show usage breakdown",
      "Rename",
      "Fork session",
      "Turn auto-approve on",
      "Compact",
      "Copy session title",
      "Close session",
      "Delete",
    ]);
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, f.oc.root, `${theme}-reply-usage-menu`);
    }
    await invoke(b, "Show usage breakdown");
    await b.poll(
      `!!document.querySelector('.otk-turn-usage :popover-open .otk-usage-breakdown tbody tr')`,
    );
    assertEquals(
      await b.evaluate(
        `document.querySelectorAll('.otk-usage-breakdown tbody tr').length`,
      ),
      1,
    );
    assertEquals(
      await b.evaluate(
        `document.querySelector('.otk-usage-breakdown tbody tr td').textContent`,
      ),
      "answered",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, f.oc.root, `${theme}-usage-open`);
    }
    assertEquals(b.errors, []);
    console.info("C2 stock screenshot root", f.oc.root);
  } finally {
    await client?.close();
    await f.stop();
  }
});
