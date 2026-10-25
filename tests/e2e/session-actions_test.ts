// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { Cdp } from "../support/cdp.ts";
import { menuReady } from "../support/menu.ts";
import { WsClient } from "../support/ws-client.ts";

const menu = ':popover-open [role="menu"][aria-label="Context menu"]';

for (const theme of ["otk-dark", "otk-light"]) {
  test(`fork hover actions retain grouped replies and fork notes in ${theme}`, async () => {
    const f = await browserFixture({ bash: "allow" });
    let client: WsClient | undefined;
    try {
      const original = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Fork source" },
      });
      const server = await f.sidecar();
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      const b = await f.browser(server.url);
      await openSession(b, original.id);
      f.fake.queue({
        tool: {
          name: "bash",
          input: { command: "pwd", description: "Read shared directory" },
        },
      }, { chunks: ["First grouped reply."] });
      await b.fill('textarea[name="prompt"]', "First prompt");
      await b.key("Enter");
      await waitForReply(b, original.id, "First grouped reply.");
      f.fake.queue({ chunks: ["Second reply."] });
      await b.fill('textarea[name="prompt"]', "Second prompt");
      await b.key("Enter");
      await waitForReply(b, original.id, "Second reply.");
      const reply = '[data-role="assistant"]';
      await b.evaluate(
        `document.querySelector('${reply}').scrollIntoView({block:'center',behavior:'instant'})`,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 1,
        y: 1,
      });
      await b.poll(
        `getComputedStyle(document.querySelector('${reply} .otk-message-actions')).opacity==='0'`,
      );
      await b.evaluate(
        `(()=>{const el=document.querySelector('${reply}');globalThis.hoverOpened=0;el.addEventListener('mouseenter',()=>{globalThis.hoverStart=performance.now()},{once:true});const observer=new MutationObserver(()=>{if(el.classList.contains('is-revealed')){globalThis.hoverOpened=performance.now()-globalThis.hoverStart;observer.disconnect()}});observer.observe(el,{attributes:true,attributeFilter:['class']})})()`,
      );
      const point = await b.evaluate<{ x: number; y: number }>(
        `(()=>{const r=document.querySelector('${reply} .otk-message-content').getBoundingClientRect();return {x:r.x+10,y:r.y+r.height-10}})()`,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await b.poll("globalThis.hoverOpened>0");
      assert(await b.evaluate<number>("globalThis.hoverOpened") >= 500);
      assertEquals(
        await b.evaluate(
          `(()=>{const footer=document.querySelector('${reply} .otk-message-footer'),copy=footer.querySelector('[data-message-command="reply.copy"]').getBoundingClientRect(),clock=footer.querySelector('.otk-last-output-time').getBoundingClientRect();return clock.left-copy.right===parseFloat(getComputedStyle(footer).columnGap)})()`,
        ),
        true,
        "Actions must sit one normal gap before the clock",
      );
      await capture(b, `${theme}-reply-hover`);
      const geometry = await b.evaluate(
        `(()=>{const el=document.querySelector('${reply}');return {height:el.getBoundingClientRect().height,top:el.getBoundingClientRect().top}})()`,
      );
      await b.evaluate(
        `(()=>{const el=document.querySelector('${reply}');globalThis.hoverClosed=0;el.addEventListener('mouseleave',()=>{globalThis.hoverLeaveStart=performance.now()},{once:true});const observer=new MutationObserver(()=>{if(!el.classList.contains('is-revealed')){globalThis.hoverClosed=performance.now()-globalThis.hoverLeaveStart;observer.disconnect()}});observer.observe(el,{attributes:true,attributeFilter:['class']})})()`,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 1,
        y: 1,
      });
      assertEquals(
        await b.evaluate(
          `document.querySelector('${reply}').classList.contains('is-revealed')`,
        ),
        true,
      );
      await b.poll(
        `!document.querySelector('${reply}').classList.contains('is-revealed')`,
      );
      assert(await b.evaluate<number>("globalThis.hoverClosed") >= 150);
      assertEquals(
        await b.evaluate(
          `(()=>{const el=document.querySelector('${reply}');return {height:el.getBoundingClientRect().height,top:el.getBoundingClientRect().top}})()`,
        ),
        geometry,
      );
      const forkSelector = `${reply} [data-message-command="reply.fork"]`;
      const forkRect = () =>
        b.evaluate(
          `document.querySelector('${forkSelector}').getBoundingClientRect().toJSON()`,
        );
      const fixedSlot = await forkRect();
      await b.key("Tab");
      await b.evaluate(
        `document.querySelector('${reply} .otk-message-agent').focus({preventScroll:true})`,
      );
      await b.poll(
        `getComputedStyle(document.querySelector('${reply} .otk-created-time')).display!=='none'`,
      );
      assertEquals(
        await forkRect(),
        fixedSlot,
        "Agent focus must not move Fork",
      );
      await b.evaluate(
        "document.querySelector('textarea[name=prompt]').focus({preventScroll:true})",
      );
      await b.poll(
        `getComputedStyle(document.querySelector('${reply} .otk-created-time')).display==='none'`,
      );
      assertEquals(
        await forkRect(),
        fixedSlot,
        "Agent blur must not move Fork",
      );
      const agentPoint = await b.evaluate<{ x: number; y: number }>(
        `(()=>{const r=document.querySelector('${reply} .otk-message-agent').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...agentPoint,
      });
      await b.poll(
        `getComputedStyle(document.querySelector('${reply} .otk-created-time')).display!=='none'`,
      );
      assertEquals(
        await forkRect(),
        fixedSlot,
        "Agent hover must not move Fork",
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 1,
        y: 1,
      });
      await b.poll(
        `getComputedStyle(document.querySelector('${reply} .otk-created-time')).display==='none'`,
      );
      assertEquals(
        await forkRect(),
        fixedSlot,
        "Agent leave must not move Fork",
      );
      await b.click(`${reply} .otk-message-agent`);
      await b.poll(
        `getComputedStyle(document.querySelector('${reply} .otk-message-actions')).opacity==='1'`,
      );
      await b.click(`${reply} [data-message-command="reply.fork"]`);
      await b.poll(
        `!location.hash.endsWith('/${original.id}') && !!document.querySelector('.otk-fork-note')`,
      );
      const forkID = await b.evaluate<string>(
        "location.hash.split('/').at(-1)",
      );
      await b.poll(
        `document.querySelectorAll('[data-role="user"]').length===1 && document.querySelectorAll('[data-role="assistant"]').length===1`,
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('textarea[name=prompt]').value",
        ),
        "",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-fork-note').textContent.includes('Files are shared with the original.')",
        ),
        true,
      );
      await capture(b, `${theme}-fork-note`);
      assertEquals(
        await b.evaluate(
          `(()=>{const note=document.querySelector('.otk-fork-note'),button=note.querySelector('button'),icons=[note.querySelector(':scope > svg'),button.querySelector('svg')];return {button:[button.getBoundingClientRect().width,button.getBoundingClientRect().height],icons:icons.map(icon=>[icon.getBoundingClientRect().width,icon.getBoundingClientRect().height])}})()`,
        ),
        { button: [28, 28], icons: [[16, 16], [16, 16]] },
      );
      const raw = await f.oc.request<{ info: { role: string } }[]>(
        `/session/${forkID}/message`,
      );
      assertEquals(raw.map((m) => m.info.role), [
        "user",
        "assistant",
        "assistant",
      ]);
      await b.evaluate(
        `document.querySelector('[data-role="user"]').scrollIntoView({block:'center',behavior:'instant'})`,
      );
      const copySelector =
        '[data-role="user"] [data-message-command="prompt.copy"]';
      const copyRect = () =>
        b.evaluate(
          `document.querySelector('${copySelector}').getBoundingClientRect().toJSON()`,
        );
      const fixedCopy = await copyRect();
      await b.evaluate(
        `document.querySelector('[data-role="user"] .otk-user-bubble').focus({preventScroll:true})`,
      );
      await b.poll(
        `getComputedStyle(document.querySelector('[data-role="user"] .otk-message-actions')).opacity==='1'`,
      );
      assertEquals(
        await copyRect(),
        fixedCopy,
        "Bubble focus must not move Copy",
      );
      await capture(b, `${theme}-prompt-hover`);
      await b.send("Browser.grantPermissions", {
        origin: server.url,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      await b.click(copySelector);
      await b.poll(
        `navigator.clipboard.readText().then(text=>text==='First prompt')`,
      );
      assertEquals(
        await copyRect(),
        fixedCopy,
        "Copy activation must retain its slot",
      );
      await b.fill('textarea[name="prompt"]', "Fork writes a shared file");
      f.fake.queue({
        tool: {
          name: "bash",
          input: {
            command: "echo shared > fork-shared.txt",
            description: "Write shared file",
          },
        },
      }, { chunks: ["Shared file written."] });
      await b.key("Enter");
      await waitForReply(b, forkID, "Shared file written.");
      await b.poll("!document.querySelector('.otk-fork-note')");
      assertEquals(
        await Deno.readTextFile(join(f.oc.directory, "fork-shared.txt")),
        "shared\n",
      );
      await openSession(b, original.id);
      await b.poll(
        `document.querySelectorAll('[data-role="user"]').length===2`,
      );
      await b.fill('textarea[name="prompt"]', "Keep original draft");
      await sessionContext(b, `[data-session="${original.id}"]`);
      await b.click(`${menu} [data-context-command="session.fork"]`);
      await b.poll(
        `!location.hash.endsWith('/${original.id}') && !!document.querySelector('.otk-fork-note')`,
      );
      await b.poll(
        `document.querySelectorAll('[data-role="user"]').length===2`,
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('textarea[name=prompt]').value",
        ),
        "",
      );
      await b.click('[aria-label="Dismiss fork note"]');
      await b.poll("!document.querySelector('.otk-fork-note')");
      await openSession(b, original.id);
      assertEquals(
        await b.evaluate(
          "document.querySelector('textarea[name=prompt]').value",
        ),
        "Keep original draft",
      );
      assertEquals(b.errors, []);
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}
export async function sessionContext(b: Cdp, selector: string) {
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
}
async function capture(b: Cdp, name: string) {
  const destination = Deno.env.get("OTK_SESSION_ACTION_SCREENSHOTS");
  if (destination) await b.screenshot(join(destination, `${name}.png`));
}

test("working family deletion names helpers and aborts before native removal", async () => {
  const f = await browserFixture();
  const mutations: string[] = [];
  const proxy = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      if (
        request.method === "DELETE" || url.pathname.endsWith("/abort")
      ) mutations.push(`${request.method} ${url.pathname}`);
      url.host = new URL(f.oc.url).host;
      return fetch(new Request(url, request));
    },
  );
  let client: WsClient | undefined;
  try {
    const root = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Working family" },
    });
    const child = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Family helper", parentID: root.id },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.addr.port}` },
    });
    client = new WsClient(server.url);
    await client.connect();
    f.fake.queue({
      chunks: Array.from({ length: 30 }, () => "Still working. "),
      delay: 1000,
    });
    await client.rpc("session.prompt", {
      sessionID: root.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Keep working until interrupted" }],
      model: { provider: "fake", model: "scripted" },
    });
    const b = await f.browser(server.url);
    await openSession(b, root.id);
    await b.poll(
      `document.querySelector('[data-session="${root.id}"]')?.dataset.status==='busy'`,
    );
    const item = `${menu} [data-context-command="session.delete"]`;
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await sessionContext(b, `[data-tab="${root.id}"]`);
      await b.click(item);
      await b.poll(
        `document.querySelector('${item}')?.textContent==='Press again to stop and delete, including 1 helper'`,
      );
      await capture(b, `${theme}-delete-working-armed`);
      await b.key("Escape");
    }
    await sessionContext(b, `[data-tab="${root.id}"]`);
    await b.click(item);
    await b.poll(
      `document.querySelector('${item}')?.classList.contains('is-armed')`,
    );
    await b.click(item);
    await b.poll(
      `!document.querySelector('[data-session="${root.id}"]') && !document.querySelector('[data-session="${child.id}"]') && location.hash.startsWith('#project/')`,
    );
    assertEquals(mutations, [
      `POST /session/${root.id}/abort`,
      `DELETE /session/${root.id}`,
    ]);
    await assertRejects(
      () => f.oc.request(`/session/${child.id}`),
      Error,
      "404",
    );
    assertEquals(b.errors, []);
  } finally {
    await client?.close();
    await f.stop();
    await proxy.shutdown();
  }
});

for (const theme of ["otk-dark", "otk-light"]) {
  test(`rename edits only its tab, chip or row and persists after reload in ${theme}`, async () => {
    const f = await browserFixture();
    let client: WsClient | undefined;
    try {
      const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Session actions" },
      });
      const server = await f.sidecar();
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      const b = await f.browser(server.url);
      await openSession(b, session.id);
      await b.evaluate("document.fonts.ready.then(()=>true)");
      for (
        const [origin, selector] of [
          ["tab", `[data-tab="${session.id}"]`],
          ["chip", `[data-crumb="${session.id}"]`],
          ["row", `[data-session="${session.id}"]`],
        ]
      ) {
        await sessionContext(b, selector);
        if (origin === "tab") await capture(b, `${theme}-session-menu`);
        await b.click(`${menu} [data-context-command="session.rename"]`);
        await b.poll(
          `document.activeElement?.matches('.otk-title-editor input')`,
        );
        assertEquals(
          await b.evaluate(
            "document.querySelectorAll('.otk-title-editor').length",
          ),
          1,
        );
        assertEquals(
          await b.evaluate(
            `document.querySelector('.otk-title-editor')?.dataset.origin`,
          ),
          origin,
        );
        assertEquals(
          await b.evaluate(
            "(()=>{const e=document.activeElement;return e.selectionStart===0&&e.selectionEnd===e.value.length})()",
          ),
          true,
        );
        await capture(b, `${theme}-rename-${origin}`);
        await b.send("Input.insertText", { text: `Renamed from ${origin}` });
        await b.key("Enter");
        await b.poll(
          `!document.querySelector('.otk-title-editor') && document.querySelector('[data-session="${session.id}"] .otk-row-title')?.textContent==='Renamed from ${origin}'`,
        );
        assertEquals(
          (await f.oc.request<{ title: string }>(`/session/${session.id}`))
            .title,
          `Renamed from ${origin}`,
        );
      }
      await sessionContext(b, `[data-session="${session.id}"]`);
      await b.click(`${menu} [data-context-command="session.rename"]`);
      await b.poll(
        `document.activeElement?.matches('.otk-title-editor input')`,
      );
      await b.send("Input.insertText", { text: "Cancelled title" });
      await b.key("Escape");
      await b.poll("!document.querySelector('.otk-title-editor')");
      await sessionContext(b, `[data-session="${session.id}"]`);
      await b.click(`${menu} [data-context-command="session.rename"]`);
      await b.poll(
        `document.activeElement?.matches('.otk-title-editor input')`,
      );
      await b.key("Backspace");
      await b.key("Enter");
      await b.poll("!document.querySelector('.otk-title-editor')");
      await sessionContext(b, `[data-session="${session.id}"]`);
      await b.click(`${menu} [data-context-command="session.rename"]`);
      await b.poll(
        `document.activeElement?.matches('.otk-title-editor input')`,
      );
      await b.send("Input.insertText", { text: "Committed on blur" });
      await b.click(".otk-prompt textarea");
      await b.poll(
        `!document.querySelector('.otk-title-editor') && document.querySelector('[data-session="${session.id}"] .otk-row-title')?.textContent==='Committed on blur'`,
      );
      await b.reload();
      await openSession(b, session.id);
      assertEquals(
        await b.evaluate(
          `document.querySelector('[data-session="${session.id}"] .otk-row-title').textContent`,
        ),
        "Committed on blur",
      );
      assertEquals(b.errors, []);
    } finally {
      await client?.close();
      await f.stop();
    }
  });

  test(`delete protects lost drafts, disarms on navigation and removes native sessions in ${theme}`, async () => {
    const f = await browserFixture();
    let client: WsClient | undefined;
    try {
      const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Draft to protect" },
      });
      const server = await f.sidecar();
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      const b = await f.browser(server.url);
      await openSession(b, session.id);
      await b.fill('textarea[name="prompt"]', "Keep this unsent draft");
      await sessionContext(b, `[data-tab="${session.id}"]`);
      await b.click(`${menu} [data-context-command="session.close"]`);
      await b.poll("location.hash.startsWith('#project/')");
      assertEquals(
        b.events.filter((event) =>
          event.method === "Page.javascriptDialogOpening"
        ).length,
        0,
      );
      await openSession(b, session.id);
      await b.poll(
        `document.querySelector('textarea[name="prompt"]')?.value==='Keep this unsent draft'`,
      );
      const item = `${menu} [data-context-command="session.delete"]`;
      await sessionContext(b, `[data-session="${session.id}"]`);
      await b.click(item);
      await b.poll(
        `document.querySelector('${item}')?.textContent==='Press again to delete'`,
      );
      await b.dialog(() => b.click(item), false);
      await b.poll(`!document.querySelector(':popover-open')`);
      assertEquals(
        (await f.oc.request<{ id: string }>(`/session/${session.id}`)).id,
        session.id,
      );
      assertEquals(
        await b.evaluate(
          `document.querySelector('textarea[name="prompt"]').value`,
        ),
        "Keep this unsent draft",
      );
      await sessionContext(b, `[data-tab="${session.id}"]`);
      await b.click(item);
      await b.dialog(() => b.click(item), true);
      await b.poll(
        `!document.querySelector('[data-session="${session.id}"]') && !document.querySelector('[data-tab="${session.id}"]') && location.hash.startsWith('#project/')`,
      );
      await assertRejects(
        () => f.oc.request(`/session/${session.id}`),
        Error,
        "404",
      );

      const empty = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Empty draft" },
      });
      await openSession(b, empty.id);
      await sessionContext(b, `[data-tab="${empty.id}"]`);
      await capture(b, `${theme}-delete-menu`);
      await b.click(item);
      await b.poll(
        `document.querySelector('${item}')?.textContent==='Press again to delete'`,
      );
      await capture(b, `${theme}-delete-armed`);
      const renamePoint = await b.evaluate<{ x: number; y: number }>(
        `(()=>{const r=document.querySelector('${menu} [data-context-command="session.rename"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...renamePoint,
        button: "none",
        buttons: 0,
      });
      await b.poll(`document.querySelector('${item}')?.textContent==='Delete'`);
      await b.click(item);
      await b.poll(
        `document.querySelector('${item}')?.textContent==='Press again to delete'`,
      );
      await b.key("ArrowUp");
      await b.poll(`document.querySelector('${item}')?.textContent==='Delete'`);
      await b.key("ArrowDown");
      await b.key("Enter");
      await b.poll(
        `document.querySelector('${item}')?.textContent==='Press again to delete'`,
      );
      await b.key("Tab");
      await b.poll(`!document.querySelector(':popover-open')`);
      await sessionContext(b, `[data-tab="${empty.id}"]`);
      await b.click(item);
      await b.poll(
        `document.querySelector('${item}')?.textContent==='Press again to delete'`,
      );
      const dialogs = b.events.filter((event) =>
        event.method === "Page.javascriptDialogOpening"
      ).length;
      await b.click(item);
      await b.poll(`!document.querySelector('[data-session="${empty.id}"]')`);
      assertEquals(
        b.events.filter((event) =>
          event.method === "Page.javascriptDialogOpening"
        ).length,
        dialogs,
      );
      await assertRejects(
        () =>
          f.oc.request(`/session/${empty.id}`),
        Error,
        "404",
      );
      assertEquals(b.errors, []);
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}
