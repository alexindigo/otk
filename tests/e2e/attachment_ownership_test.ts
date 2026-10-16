// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";

Deno.test("P9 upload completions preserve edits, removals, concurrent work and replaced session drafts", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Upload ownership" },
    });
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Other draft" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.evaluate(
      `(()=>{const read=File.prototype.arrayBuffer;window.uploadReads=[];File.prototype.arrayBuffer=function(){return new Promise(resolve=>window.uploadReads.push({name:this.name,complete:async()=>resolve(await read.call(this))}));};window.dropUploadFiles=names=>{const data=new DataTransfer();for(const name of names)data.items.add(new File(['bytes:'+name],name,{type:'text/plain'}));document.querySelector('.otk-prompt').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));};window.dropUploadFiles(['removed.txt','second.txt']);})()`,
    );
    await browser.poll(
      "window.uploadReads.length===1 && !!document.querySelector('.otk-prompt-chip')",
    );
    await browser.type("textarea[name=prompt]", " surrounding edits ");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value.includes('surrounding edits')",
    );
    await browser.click(
      '.otk-prompt-chip button[aria-label="Remove [File 1]"]',
    );
    await browser.evaluate("window.uploadReads[0].complete()");
    await browser.poll("window.uploadReads.length===2");
    await browser.evaluate("window.dropUploadFiles(['third.txt'])");
    await browser.poll("window.uploadReads.length===3");
    await browser.evaluate("window.uploadReads[2].complete()");
    await browser.poll(
      "[...document.querySelectorAll('.otk-prompt-chip')].some(el=>!el.textContent.includes('reading…'))",
    );
    await browser.evaluate("window.uploadReads[1].complete()");
    await browser.poll(
      "document.querySelectorAll('.otk-prompt-chip').length===2 && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    f.fake.queue({ chunks: ["All retained file bytes received."] });
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
          row.parts.filter((part) => part.type === "file").length === 2
        ),
    );
    const parts = messages.find((row) => row.info.role === "user")!.parts;
    assertEquals(
      parts.filter((part) => part.type === "file").map((part) => part.filename)
        .sort(),
      ["second.txt", "third.txt"],
    );
    for (const name of ["second.txt", "third.txt"]) {
      assertEquals(
        parts.find((part) => part.filename === name)?.url,
        "data:text/plain;base64," + btoa("bytes:" + name),
      );
    }
    assertEquals(
      parts.some((part) =>
        part.type === "text" && part.text?.includes("surrounding edits")
      ),
      true,
    );
    await browser.poll("!document.querySelector('.otk-prompt-chip')");
    await browser.evaluate("window.dropUploadFiles(['old-session.txt'])");
    await browser.poll(
      "window.uploadReads.length===4 && !!document.querySelector('.otk-prompt-chip')",
    );
    await browser.click(`[data-session="${other.id}"]`);
    await browser.poll(
      `location.hash.endsWith('/${other.id}') && !document.querySelector('.otk-prompt-chip')`,
    );
    await browser.type("textarea[name=prompt]", "replacement draft");
    await browser.evaluate("window.uploadReads[3].complete()");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='replacement draft' && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-prompt-chip').length",
      ),
      0,
    );
    await openSession(browser, session.id);
    await browser.poll(
      "document.querySelector('.otk-prompt-chip')?.textContent.includes('[File 1]') && !document.querySelector('.otk-prompt-chip').textContent.includes('reading…') && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    f.fake.queue({ chunks: ["Retained upload received."] });
    await browser.click(".otk-prompt button[type=submit]");
    await waitFor(
      () =>
        f.oc.request<{ parts: { filename?: string; url?: string }[] }[]>(
          `/session/${session.id}/message`,
        ),
      (rows) =>
        rows.some((row) =>
          row.parts.some((part) =>
            part.filename === "old-session.txt" &&
            part.url ===
              "data:text/plain;base64," + btoa("bytes:old-session.txt")
          )
        ),
    );
  } finally {
    await f.stop();
  }
});
