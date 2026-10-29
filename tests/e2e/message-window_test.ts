// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { Message } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { Cdp } from "../support/cdp.ts";
import { openSession } from "../support/browser-fixture.ts";
import { join } from "@std/path";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";
import { wheelViewport } from "../support/message-viewport.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`transcript windows acquired history and reveals an unmounted Timeline identity (${theme})`, async () => {
    const root = await fixture();
    const messages: Message[] = Array.from({ length: 105 }, (_, i) => ({
      id: `prompt-${i}`,
      sessionID: "tstv1-otk",
      role: "user",
      time: { created: i + 1 },
      parts: [{
        id: `text-${i}`,
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: `Window prompt ${i}` }],
        }],
      }],
    }));
    const f = await inboxBrowserFixture(root, [], { "tstv1-otk": messages });
    const client = new WsClient(f.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "theme", value: theme });
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    const b = await Cdp.launch(root);
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(f.url);
    await openSession(b, "tstv1-otk");
    await b.click("[data-panel-view=timeline]");
    const acquired =
      "Number(document.querySelector('.otk-timeline')?.dataset.promptCount ?? document.querySelectorAll('[data-timeline-prompt]').length)";
    await b.poll(`${acquired}>=20`);
    while (await b.evaluate<number>(acquired) < 105) {
      const before = await b.evaluate<number>(acquired);
      await b.click(".otk-timeline-older");
      await b.poll(`${acquired}>${before}`);
    }
    await b.poll("!document.querySelector('.otk-timeline-older')");
    const mounted = await b.evaluate<number>(
      "document.querySelectorAll('[data-role=user]').length",
    );
    assert(
      mounted < 20,
      `105 acquired prompts must not mean ${mounted} mounted prompts`,
    );
    await wheelViewport(b, ".otk-timeline-list", -100000);
    await b.poll("!!document.querySelector('[data-timeline-prompt=prompt-0]')");
    await b.click("[data-timeline-prompt=prompt-0] .otk-timeline-reveal");
    await b.poll(
      "(()=>{const e=document.activeElement,p=document.querySelector('.otk-messages').getBoundingClientRect();if(e?.closest('[data-message]')?.dataset.message!=='prompt-0')return false;const r=e.getBoundingClientRect();return r.top>=p.top && r.bottom<=p.bottom+1})()",
    );
    const shots = Deno.env.get("OTK_MESSAGES_SHOTS");
    if (shots) {
      await Deno.mkdir(shots, { recursive: true });
      await b.screenshot(join(shots, `${theme}-timeline-far-reveal.png`));
    }
    await b.send("Browser.grantPermissions", {
      origin: f.url,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await b.key("a", 2);
    await b.poll(
      "document.querySelectorAll('[data-role=user]').length===105 && document.getSelection().toString().includes('Window prompt 104')",
    );
    await b.key("c", 2);
    const copied = await b.evaluate<string>("navigator.clipboard.readText()");
    for (let i = 0; i < 105; i++) {
      assert(
        copied.includes(`Window prompt ${i}`),
        `clipboard omitted prompt ${i}: ${copied.slice(0, 300)}`,
      );
    }
    await b.evaluate("document.getSelection().removeAllRanges()");
    await wheelViewport(b, ".otk-messages", -100000);
    await b.poll(
      "!!document.querySelector('[data-message=prompt-2] .otk-text p')",
    );
    await b.evaluate(`(()=>{
    const first=document.querySelector('[data-message=prompt-0] .otk-text p').firstChild;
    const last=document.querySelector('[data-message=prompt-2] .otk-text p').firstChild;
    const range=document.createRange();range.setStart(first,0);range.setEnd(last,last.length);
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);globalThis.promptRange=range;
  })()`);
    await wheelViewport(b, ".otk-messages", 100000);
    await b.poll(
      "(()=>{const e=document.querySelector('[data-message=prompt-104]'),v=document.querySelector('.otk-messages').getBoundingClientRect();return e && e.getBoundingClientRect().top<v.bottom && e.getBoundingClientRect().bottom>v.top})()",
    );
    await b.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    await b.key("c", 2);
    const selected = await b.evaluate<string>("navigator.clipboard.readText()");
    for (const id of [0, 1, 2]) {
      assert(
        selected.includes(`Window prompt ${id}`),
        `selection omitted ${id}`,
      );
    }
    assertEquals(
      await b.evaluate(
        "document.getSelection().getRangeAt(0)===globalThis.promptRange",
      ),
      true,
    );
    await wheelViewport(b, ".otk-messages", -100000);
    await b.poll(
      "document.getSelection().toString().includes('Window prompt 1') && document.querySelector('[data-message=prompt-0]')?.getBoundingClientRect().bottom>document.querySelector('.otk-messages').getBoundingClientRect().top",
    );
    if (shots) {
      await b.screenshot(join(shots, `${theme}-recycled-selection.png`));
    }
    await b.evaluate("document.getSelection().removeAllRanges()");
    assertEquals(b.errors, []);
    await client.close();
  });
}

for (const theme of ["otk-dark", "otk-light"]) {
  test(`older page prepend keeps the same anchored bubble within one pixel (${theme})`, async () => {
    const root = await fixture();
    const messages: Message[] = Array.from({ length: 105 }, (_, i) => ({
      id: `anchor-${i}`,
      sessionID: "tstv1-otk",
      role: "user",
      time: { created: i + 1 },
      parts: [{
        id: `part-${i}`,
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: `Anchored prompt ${i}` }],
        }],
      }],
    }));
    const f = await inboxBrowserFixture(root, [], { "tstv1-otk": messages });
    const client = new WsClient(f.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "theme", value: theme });
    const read = f.app.backend.core.listMessages.bind(f.app.backend.core);
    let held = true, pending = 0, release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.app.backend.core.listMessages = async (id, opts, signal) => {
      if (held && opts.before) {
        pending++;
        await gate;
      }
      return read(id, opts, signal);
    };
    try {
      const b = await Cdp.launch(root);
      await b.goto(f.url);
      await openSession(b, "tstv1-otk");
      await b.click("[data-panel-view=timeline]");
      held = true;
      await b.click('[data-timeline-prompt="anchor-95"] .otk-timeline-reveal');
      await b.poll(
        "document.activeElement?.closest('[data-message]')?.dataset.message==='anchor-95'",
      );
      await waitFor(() => pending, (n) => n > 0);
      await b.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const before = await b.evaluate<{ top: number; count: number }>(
        "(()=>{const p=document.querySelector('.otk-messages').getBoundingClientRect();return {top:document.querySelector('[data-message=anchor-95]').getBoundingClientRect().top-p.top,count:Number(document.querySelector('.otk-message-flow').dataset.messageCount)}})()",
      );
      held = false;
      release();
      await b.poll(
        `(()=>{const e=document.querySelector('[data-message=anchor-95]'),p=document.querySelector('.otk-messages').getBoundingClientRect();return Number(document.querySelector('.otk-message-flow').dataset.messageCount)>${before.count} && e && Math.abs(e.getBoundingClientRect().top-p.top-(${before.top}))<=1})()`,
      );
      assertEquals(b.errors, []);
    } finally {
      release();
      await client.close();
    }
  });
}

for (const theme of ["otk-dark", "otk-light"]) {
  test(`a large diff shares the transcript window, preserves native selection and its measured anchor (${theme})`, async () => {
    const root = await fixture();
    const lines = Array.from(
      { length: 1000 },
      (_, i) => `source_line_${String(i).padStart(4, "0")} = ${i};`,
    );
    const messages: Message[] = [{
      id: "reply",
      sessionID: "tstv1-otk",
      role: "assistant",
      replyTo: "prompt",
      agent: "build",
      model: { provider: "test", model: "test" },
      time: { created: 1, completed: 2 },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [{
        id: "edit",
        kind: "tool",
        call: {
          tool: "edit",
          callID: "edit",
          status: "completed",
          awaitingPermission: false,
          time: { start: 1, end: 2 },
          path: `${root}/window.ts`,
          diagnostics: [],
          files: [{
            path: `${root}/window.ts`,
            status: "modified",
            additions: 1000,
            deletions: 0,
            hunks: [{
              oldStart: 1,
              newStart: 1,
              oldLines: 0,
              newLines: 1000,
              lines: lines.map((text, i) => ({
                kind: "add",
                text,
                newNo: i + 1,
              })),
            }],
          }],
        },
      }],
    }];
    const f = await inboxBrowserFixture(root, [], { "tstv1-otk": messages });
    const client = new WsClient(f.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "theme", value: theme });
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    const b = await Cdp.launch(root);
    await b.goto(f.url);
    await openSession(b, "tstv1-otk");
    await b.send("Browser.grantPermissions", {
      origin: f.url,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    // A real upward intent owns history before expanding source.
    const point = await b.evaluate<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('.otk-messages').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: -100,
    });
    await b.click(".otk-tool-toggle");
    await b.poll(
      "document.querySelector('.otk-diff-text')?.textContent==='source_line_0000 = 0;'",
    );
    assert(
      (await b.evaluate<number>(
        "document.querySelectorAll('.otk-diff-unified').length",
      )) < 50,
    );
    await b.evaluate(`(()=>{
      const texts=[...document.querySelectorAll('.otk-diff-text')];
      const range=document.createRange();range.setStart(texts[0].firstChild,0);range.setEnd(texts[2].firstChild,texts[2].textContent.length);
      const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
      globalThis.diffRange=selection.getRangeAt(0);globalThis.diffSource=selection.toString();
    })()`);
    await wheelViewport(b, ".otk-messages", 900);
    await b.poll(
      "document.getSelection().getRangeAt(0)===globalThis.diffRange && globalThis.diffRange.startContainer.isConnected && document.getSelection().toString()===globalThis.diffSource",
    );
    await b.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    await b.key("c", 2);
    const copied = await b.evaluate<string>("navigator.clipboard.readText()");
    assertEquals(copied.replace(/\n+$/, ""), lines.slice(0, 3).join("\n"));
    await b.evaluate(
      "document.getSelection().removeAllRanges(); document.activeElement?.blur()",
    );
    await b.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    await b.poll(
      "(()=>{const v=document.querySelector('.otk-messages').getBoundingClientRect(),rows=[...document.querySelectorAll('.otk-diff-unified')];return rows.length>0 && rows.every(e=>{const r=e.getBoundingClientRect();return r.bottom>v.top && r.top<v.bottom})})()",
    );
    const anchor = await b.evaluate<{ line: string; top: number }>(
      "(()=>{const v=document.querySelector('.otk-messages').getBoundingClientRect(),row=[...document.querySelectorAll('.otk-diff-unified')].find(e=>e.getBoundingClientRect().bottom>v.top);return {line:row.dataset.newLine,top:row.getBoundingClientRect().top-v.top}})()",
    );
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const label of ["Collapse projects", "Collapse right panel"]) {
      if (
        await b.evaluate(`!!document.querySelector('[aria-label="${label}"]')`)
      ) await b.click(`[aria-label="${label}"]`);
    }
    await b.poll(
      `(()=>{const row=document.querySelector('.otk-diff-unified[data-new-line="${anchor.line}"]'),v=document.querySelector('.otk-messages').getBoundingClientRect();return row && Math.abs(row.getBoundingClientRect().top-v.top-(${anchor.top}))<=1})()`,
    );
    const shots = Deno.env.get("OTK_MESSAGES_SHOTS");
    if (shots) {
      await Deno.mkdir(shots, { recursive: true });
      await b.screenshot(join(shots, `${theme}-diff-selection-window.png`));
    }
    assertEquals(b.errors, []);
    await client.close();
  });
}
