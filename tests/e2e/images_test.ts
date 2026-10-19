// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("U8 pasted and dropped images have one independent chip, persist as loaded message thumbnails and open the original in Dialog", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Image review" },
    });
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Other draft" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await openSession(b, session.id);
    const shots = Deno.env.get("OTK_IMAGE_SHOTS");
    const capture = async (state: string) => {
      if (!shots) return;
      await Deno.mkdir(shots, { recursive: true });
      for (
        const [theme, name] of [["otk-dark", "dark"], ["otk-light", "light"]]
      ) {
        await client!.rpc("prefs.set", { key: "theme", value: theme });
        await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
        await b.screenshot(join(shots, `${state}-${name}.png`));
      }
    };
    const image = await b.evaluate<string>(
      `(()=>{const c=document.createElement('canvas');c.width=640;c.height=400;const x=c.getContext('2d');x.fillStyle='#234651';x.fillRect(0,0,640,400);x.fillStyle='#7fc8b8';x.fillRect(40,40,240,240);x.fillStyle='#f2c16d';x.beginPath();x.arc(440,160,100,0,Math.PI*2);x.fill();x.fillStyle='#ffffff';x.font='24px sans-serif';x.fillText('Image review · 640 × 400',40,350);return c.toDataURL('image/png')})()`,
    );
    const addImage = (event: "paste" | "drop", name = "sample.png") =>
      b.evaluate(
        `(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob(${
          JSON.stringify(image.split(",")[1])
        }),c=>c.charCodeAt(0))],${
          JSON.stringify(name)
        },{type:'image/png'}));document.querySelector('${
          event === "paste" ? "textarea[name=prompt]" : ".otk-prompt"
        }').dispatchEvent(${
          event === "paste"
            ? "new ClipboardEvent('paste',{bubbles:true,clipboardData:d})"
            : "new DragEvent('drop',{bubbles:true,dataTransfer:d})"
        });})()`,
      );
    await b.fill("textarea[name=prompt]", "What is in this image?");
    await addImage("paste");
    await b.poll(
      "document.querySelectorAll('.otk-prompt-chip').length===1 && !document.querySelector('.otk-prompt-chip').textContent.includes('reading…')",
    );
    await capture("composer");
    assertEquals(
      await b.evaluate("document.querySelector('textarea[name=prompt]').value"),
      "What is in this image?",
    );
    await b.poll(
      "(()=>{const i=document.querySelector('.otk-prompt-chip img');return i?.complete && i.naturalWidth===640})()",
    );
    assertEquals(
      await b.evaluate("document.querySelector('.otk-prompt-chip img').src"),
      image,
    );
    assert(
      await b.evaluate(
        "(()=>{const i=document.querySelector('.otk-prompt-chip img').getBoundingClientRect(),r=document.querySelector('.otk-prompt-chip button:last-child').getBoundingClientRect();return Math.abs(i.y+i.height/2-r.y-r.height/2)<.5})()",
      ),
    );
    await b.fill("textarea[name=prompt]", "Edited question");
    await b.click('[aria-label="Edit prompt"]');
    await b.poll("!!document.querySelector('textarea[name=editor]')");
    await b.fill("textarea[name=editor]", "Describe these shapes.");
    await b.click(".otk-editor footer button:last-child");
    await b.poll(
      "!document.querySelector('dialog[open]') && !!document.querySelector('.otk-prompt-chip img')",
    );
    await openSession(b, other.id);
    await b.poll("!document.querySelector('.otk-prompt-chip')");
    await openSession(b, session.id);
    await b.poll(
      "document.querySelector('textarea[name=prompt]').value==='Describe these shapes.' && !!document.querySelector('.otk-prompt-chip img')",
    );
    f.fake.queue({ chunks: ["The image contains a square and a circle."] });
    await b.click(".otk-prompt button[type=submit]");
    await b.poll(
      "(()=>{const i=document.querySelector('[data-role=user] .otk-file-image img');return i?.complete && i.naturalWidth===640})()",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-role=user] .otk-text').textContent.trim()",
      ),
      "Describe these shapes.",
    );
    const rows = await waitFor(
      () =>
        f.oc.request<
          {
            info: { role: string };
            parts: { type: string; url?: string; text?: string }[];
          }[]
        >(`/session/${session.id}/message`),
      (rows) => rows.some((row) => row.info.role === "user"),
    );
    const parts = rows.find((row) => row.info.role === "user")!.parts;
    assertEquals(parts.filter((p) => p.type === "file").map((p) => p.url), [
      image,
    ]);
    assertEquals(
      parts.filter((p) => p.type === "text").some((p) =>
        p.text?.includes("[Image")
      ),
      false,
    );
    await b.poll("!document.querySelector('.otk-prompt-chip')");
    await waitForReply(
      b,
      session.id,
      "The image contains a square and a circle.",
    );
    await capture("message");
    await b.click(".otk-file-image");
    await b.poll(
      "document.querySelector('dialog[open] .otk-image-view img')?.naturalWidth===640",
    );
    assertEquals(
      await b.evaluate("document.querySelector('dialog[open] img').src"),
      image,
    );
    assert(
      await b.evaluate(
        "(()=>{const t=document.querySelector('.otk-file-image img').getBoundingClientRect(),i=document.querySelector('dialog[open] img').getBoundingClientRect();return i.width>t.width && Math.abs(i.width/i.height-1.6)<.01 && document.querySelectorAll('dialog[open] h2').length===1})()",
      ),
    );
    await capture("dialog");
    await b.key("Escape");
    await b.poll(
      "!document.querySelector('dialog[open]') && document.activeElement===document.querySelector('.otk-file-image')",
    );
    await b.reload();
    await b.poll(
      "(()=>{const i=document.querySelector('[data-role=user] .otk-file-image img');return i?.complete && i.naturalWidth===640})()",
    );
    // Image-only drafts remain sendable, and editing text cannot delete them.
    await addImage("drop", "second.png");
    await b.poll(
      "!!document.querySelector('.otk-prompt-chip img') && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    assertEquals(
      await b.evaluate("document.querySelector('textarea[name=prompt]').value"),
      "",
    );
    f.fake.queue({ chunks: ["Second image received."] });
    await b.click(".otk-prompt button[type=submit]");
    await b.poll(
      "document.querySelectorAll('[data-role=user] .otk-file-image img').length===2 && !document.querySelector('.otk-prompt-chip')",
    );
    const prompts = sentFrames(b).filter(({ frame }) =>
      frame.method === "session.prompt"
    );
    assertEquals(prompts.length, 2);
    const sent = prompts[1].frame.params as {
      parts: { kind: string; text?: string }[];
    };
    assertEquals(sent.parts.filter((p) => p.kind === "file").length, 1);
    assertEquals(
      sent.parts.filter((p) => p.kind === "text").every((p) => p.text === ""),
      true,
    );
    await waitForReply(b, session.id, "Second image received.");
    await capture("image-only");
    // New image-only history keeps attachment metadata lazy without a token.
    await b.click("textarea[name=prompt]");
    await b.key("ArrowUp");
    await b.poll(
      "document.querySelectorAll('.otk-prompt-chip').length===1 && document.querySelector('.otk-prompt-chip button').title==='second.png'",
    );
    assertEquals(
      await b.evaluate("document.querySelector('textarea[name=prompt]').value"),
      "",
    );
    assertEquals(
      sentFrames(b).filter(({ frame }) => frame.method === "history.attachment")
        .length,
      0,
    );
    f.fake.queue({ chunks: ["Recalled image received."] });
    await b.click(".otk-prompt button[type=submit]");
    await b.poll(
      "document.querySelectorAll('[data-role=user] .otk-file-image img').length===3 && !document.querySelector('.otk-prompt-chip')",
    );
    assertEquals(
      sentFrames(b).filter(({ frame }) => frame.method === "history.attachment")
        .length,
      1,
    );
    await waitForReply(b, session.id, "Recalled image received.");
    await addImage("paste", "remove.png");
    await b.poll("!!document.querySelector('.otk-prompt-chip img')");
    await b.click('.otk-prompt-chip button[aria-label^="Remove"]');
    await b.poll(
      "!document.querySelector('.otk-prompt-chip') && document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    // Ordinary file uploads retain the existing chip rendering.
    await b.evaluate(
      "(()=>{const d=new DataTransfer();d.items.add(new File(['plain bytes'],'notes.txt',{type:'text/plain'}));document.querySelector('.otk-prompt').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}));})()",
    );
    await b.poll(
      "!document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    f.fake.queue({ chunks: ["File received."] });
    await b.click(".otk-prompt button[type=submit]");
    await b.poll(
      "[...document.querySelectorAll('[data-role=user] .otk-chip')].some(e=>e.textContent.includes('notes.txt'))",
    );
    await waitForReply(b, session.id, "File received.");
    await capture("mixed-files");
  } finally {
    await client?.close();
    await f.stop();
  }
});

Deno.test("U8 a pending image stays with its session draft and explicit removal cannot be undone by a late upload", async () => {
  const f = await browserFixture();
  try {
    const a = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Pending image" },
    });
    const z = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Independent draft" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    await openSession(b, a.id);
    await b.evaluate(
      `(()=>{const read=File.prototype.arrayBuffer;globalThis.imageReads=[];File.prototype.arrayBuffer=function(){return new Promise(resolve=>imageReads.push(async()=>resolve(await read.call(this))))};globalThis.pasteImage=()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'pending.png',{type:'image/png'}));document.querySelector('textarea[name=prompt]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:d}));};pasteImage()})()`,
    );
    await b.poll(
      "imageReads.length===1 && document.querySelector('.otk-prompt-chip').textContent.includes('reading…')",
    );
    assertEquals(
      await b.evaluate("document.querySelector('textarea[name=prompt]').value"),
      "",
    );
    await openSession(b, z.id);
    await b.fill("textarea[name=prompt]", "Keep this draft");
    await b.evaluate("imageReads[0]()");
    await b.poll(
      "!document.querySelector('.otk-prompt-chip') && document.querySelector('textarea[name=prompt]').value==='Keep this draft'",
    );
    await openSession(b, a.id);
    await b.poll(
      "document.querySelector('.otk-prompt-chip img')?.naturalWidth===1",
    );
    await b.click('.otk-prompt-chip button[aria-label^="Remove"]');
    await b.evaluate("pasteImage()");
    await b.poll(
      "imageReads.length===2 && !!document.querySelector('.otk-prompt-chip')",
    );
    await b.click('.otk-prompt-chip button[aria-label^="Remove"]');
    await b.evaluate("imageReads[1]()");
    await b.poll(
      "!document.querySelector('.otk-prompt-chip') && document.querySelector('textarea[name=prompt]').value==='' && document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    assertEquals(
      sentFrames(b).filter(({ frame }) => frame.method === "session.prompt")
        .length,
      0,
    );
  } finally {
    await f.stop();
  }
});
