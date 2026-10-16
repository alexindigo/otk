// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
Deno.test("P9 client drop and image paste reach stock opencode as file parts; paths become references", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Attachments" },
      }),
      other = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Other" },
      });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.evaluate(
      `(()=>{const d=new DataTransfer();d.items.add(new File(['dropped client bytes'],'client.txt',{type:'text/plain'}));document.querySelector('.otk-prompt').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}));})()`,
    );
    await browser.poll(
      "document.querySelector('.otk-prompt-chip')?.textContent.includes('[File 1]') && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    await openSession(browser, other.id);
    await browser.poll("!document.querySelector('.otk-prompt-chip')");
    await openSession(browser, session.id);
    await browser.poll(
      `location.hash.endsWith('/${session.id}') && !!document.querySelector('.otk-prompt-chip')`,
    );
    f.fake.queue({ chunks: ["attachment received"] });
    await browser.click(".otk-prompt button[type=submit]");
    await browser.poll(
      "[...document.querySelectorAll('[data-role=user] .otk-chip')].some(el=>el.textContent.includes('client.txt'))",
    );
    const history = await waitFor(
      () =>
        f.oc.request<
          {
            info: { role: string };
            parts: { type: string; url?: string; text?: string }[];
          }[]
        >(`/session/${session.id}/message`),
      (rows) =>
        rows.some((row) => row.parts.some((part) => part.type === "file")),
    );
    assertEquals(
      history.find((row) => row.info.role === "user")!.parts.find((part) =>
        part.type === "file"
      )!.url,
      "data:text/plain;base64," + btoa("dropped client bytes"),
    );
    await browser.poll("!document.querySelector('.otk-prompt-chip')");
    await browser.evaluate(
      `(()=>{const d=new DataTransfer();d.setData('text/plain','README.md');document.querySelector('textarea[name=prompt]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:d}));})()`,
    );
    await browser.poll(
      "document.querySelector('.otk-prompt-chip')?.textContent.includes('@README.md')",
    );
    await browser.evaluate(
      `(()=>{const d=new DataTransfer();const b=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));d.items.add(new File([b],'pixel.png',{type:'image/png'}));document.querySelector('textarea[name=prompt]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:d}));})()`,
    );
    await browser.poll(
      "document.querySelector('.otk-prompt-chips').textContent.includes('[Image 1]') && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    await browser.screenshot(join(f.oc.root, "p9-attachments.png"));
  } finally {
    await f.stop();
  }
});

Deno.test("P9 oversized combined uploads show an immediate error without sending or losing the draft", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Combined uploads" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.evaluate(
      `(()=>{const d=new DataTransfer();const bytes=new Uint8Array(17*1024*1024);for(let i=1;i<=3;i++)d.items.add(new File([bytes],'part-'+i+'.txt',{type:'text/plain'}));document.querySelector('.otk-prompt').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}));})()`,
    );
    await browser.poll(
      "document.querySelectorAll('.otk-prompt-chip').length === 3 && !document.querySelector('.otk-prompt button[type=submit]').disabled",
      10000,
    );
    await browser.click(".otk-prompt button[type=submit]");
    await browser.poll(
      "document.querySelector('.otk-prompt [role=alert]')?.textContent.includes('64 MiB')",
      5000,
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) =>
        frame.method === "session.prompt"
      ).length,
      0,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-prompt-chip').length",
      ),
      3,
    );
    assertEquals(f.fake.requests.length, 0);
  } finally {
    await f.stop();
  }
});
