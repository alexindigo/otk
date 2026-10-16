// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
Deno.test("P7/P8 200-line paste and whole-prompt editor save/cancel preserve chips and emit expanded text", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Editor" },
      }),
      server = await f.sidecar(),
      browser = await f.browser(server.url);
    await openSession(browser, session.id);
    const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    await browser.evaluate(
      `(()=>{const d=new DataTransfer();d.setData('text/plain',${
        JSON.stringify(text)
      });document.querySelector('textarea[name=prompt]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:d}));})()`,
    );
    await browser.poll(
      "document.querySelector('.otk-prompt-chip')?.textContent.includes('[Pasted ~200 lines]')",
    );
    await browser.screenshot(join(f.oc.root, "p7-paste-chip.png"));
    await browser.click(".otk-prompt-chip button");
    await browser.poll(
      `document.querySelector('dialog[open] textarea')?.value===${
        JSON.stringify(text)
      }`,
    );
    await browser.fill("textarea[name=editor]", text + "\nedited line");
    const geometry = await browser.evaluate<
      {
        height: number;
        viewport: number;
        textareaBottom: number;
        footerTop: number;
        footerBottom: number;
        dialogBottom: number;
      }
    >("(()=>{const d=document.querySelector('.otk-editor').getBoundingClientRect(),t=document.querySelector('.otk-editor textarea').getBoundingClientRect(),f=document.querySelector('.otk-editor footer').getBoundingClientRect();return {height:t.height,viewport:innerHeight,textareaBottom:t.bottom,footerTop:f.top,footerBottom:f.bottom,dialogBottom:d.bottom}})()");
    assert(
      geometry.height > geometry.viewport * .6,
      "Editor textarea must fill the dialog's available vertical space",
    );
    assert(
      geometry.footerTop >= geometry.textareaBottom &&
        geometry.dialogBottom - geometry.footerBottom < 24,
      "Editor footer must follow the textarea at the bottom of the dialog",
    );
    const inset = await browser.evaluate<
      {
        top: number;
        bottom: number;
        expectedTop: number;
        expectedBottom: number;
      }
    >("(()=>{const el=document.querySelector('.otk-editor'),r=el.getBoundingClientRect(),s=getComputedStyle(el);return {top:r.top,bottom:innerHeight-r.bottom,expectedTop:parseFloat(s.top),expectedBottom:parseFloat(s.bottom)}})()");
    assert(
      Math.abs(inset.top - inset.expectedTop) <= .5 &&
        Math.abs(inset.bottom - inset.expectedBottom) <= .5,
      "Editor inset must own available height: " + JSON.stringify(inset),
    );
    await browser.screenshot(join(f.oc.root, "p7-editor.png"));
    await browser.click(".otk-editor footer button:last-child");
    await browser.poll(
      "!document.querySelector('dialog[open]') && document.querySelector('.otk-prompt-chip').textContent.includes('~201 lines')",
    );
    await browser.click(".otk-prompt-chip button");
    await browser.fill("textarea[name=editor]", "cancel this");
    await browser.key("Escape");
    await browser.poll("!document.querySelector('dialog[open]')");
    await browser.click(".otk-prompt button[type=submit]");
    await browser.poll(
      "document.querySelector('[data-role=user] .otk-text')?.textContent.includes('line 200') && document.querySelector('[data-role=user] .otk-text')?.textContent.includes('edited line') && !document.querySelector('.otk-prompt-chip')",
    );
    await browser.fill(
      "textarea[name=prompt]",
      "/editor surrounding [Pasted ~201 lines]",
    );
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('dialog[open] textarea')?.value==='surrounding [Pasted ~201 lines]'",
    );
    await browser.fill("textarea[name=editor]", "edited whole prompt");
    await browser.click(".otk-editor footer button:last-child");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='edited whole prompt'",
    );
    await browser.key("Enter");
    await browser.poll(
      "[...document.querySelectorAll('[data-role=user] .otk-text')].some(el=>el.textContent.includes('edited whole prompt'))",
    );
    assertEquals(
      await browser.evaluate("!!document.querySelector('dialog[open]')"),
      false,
    );
  } finally {
    await f.stop();
  }
});

Deno.test("editor changes and attachment completion retain one owner-current draft and submitted bytes", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Editor upload ownership" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.evaluate(
      `(()=>{const read=File.prototype.arrayBuffer;globalThis.editorReads=[];File.prototype.arrayBuffer=function(){return new Promise(resolve=>editorReads.push(async()=>resolve(await read.call(this))))};const data=new DataTransfer();data.items.add(new File(['editor-owned-bytes'],'editor-owned.txt',{type:'text/plain'}));document.querySelector('.otk-prompt').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));})()`,
    );
    await browser.poll(
      "editorReads.length===1 && document.querySelector('.otk-prompt-chip')?.textContent.includes('reading…')",
    );
    await browser.click("[aria-label='Edit prompt']");
    await browser.poll("!!document.querySelector('.otk-editor[open]')");
    await browser.fill(
      "textarea[name=editor]",
      "editor before [File 1] editor after",
    );
    await browser.evaluate("editorReads[0]()");
    await browser.poll(
      "!document.querySelector('.otk-prompt-chip').textContent.includes('reading…') && document.querySelector('textarea[name=editor]').value==='editor before [File 1] editor after'",
    );
    await browser.click(".otk-editor footer button:last-child");
    await browser.poll(
      "!document.querySelector('.otk-editor[open]') && document.querySelector('textarea[name=prompt]').value==='editor before [File 1] editor after' && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    f.fake.queue({ chunks: ["Editor attachment received."] });
    await browser.click(".otk-prompt button[type=submit]");
    const messages = await waitFor(
      () =>
        f.oc.request<
          {
            info: { role: string };
            parts: {
              type: string;
              filename?: string;
              url?: string;
              text?: string;
            }[];
          }[]
        >(`/session/${session.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.info.role === "user" &&
          row.parts.some((part) => part.filename === "editor-owned.txt")
        ),
    );
    const parts = messages.find((row) => row.info.role === "user")!.parts;
    assertEquals(
      parts.find((part) => part.filename === "editor-owned.txt")?.url,
      "data:text/plain;base64," + btoa("editor-owned-bytes"),
    );
    assert(
      parts.some((part) =>
        part.type === "text" && part.text?.includes("editor before") &&
        part.text?.includes("editor after")
      ),
    );
  } finally {
    await f.stop();
  }
});
