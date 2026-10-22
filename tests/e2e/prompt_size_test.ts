// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";

const input = "textarea[name=prompt]";
const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `Draft line ${i + 1}`).join("\n");

test("U13 prompt grows line by line up to its cap, keeps the caret and footer visible, shrinks and clears after send", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  const shots = Deno.env.get("OTK_PROMPT_SIZE_SHOTS");
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Growing prompt" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await openSession(b, session.id);
    await b.poll(
      "document.querySelector('.otk-composer-model-name')?.textContent==='scripted'",
    );
    await b.evaluate("document.fonts.ready.then(()=>true)");
    if (shots) await Deno.mkdir(shots, { recursive: true });
    const measure = () =>
      b.evaluate<{
        height: number;
        scrollHeight: number;
        scrollTop: number;
        caretTop: number;
        caretBottom: number;
        lineHeight: number;
        resize: string;
        top: number;
        bottom: number;
        footerTop: number;
        footerBottom: number;
        composerTop: number;
        composerBottom: number;
        transcriptBottom: number;
        composerScroll: number;
        documentScroll: number;
        viewport: number;
      }>(`(async()=>{
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const t=document.querySelector('${input}'),s=getComputedStyle(t),
          r=t.getBoundingClientRect(),f=document.querySelector('.otk-prompt-actions').getBoundingClientRect(),
          c=document.querySelector('.otk-composer'),cr=c.getBoundingClientRect(),
          line=parseFloat(s.lineHeight),mirror=document.createElement('div'),caret=document.createElement('span');
        // Measure the caret's inline font box, not the full line box: native
        // textareas may leave the line's unused descent below the scrollport.
        Object.assign(mirror.style,{width:r.width+'px',font:s.font,letterSpacing:s.letterSpacing,
          whiteSpace:'pre-wrap',overflowWrap:s.overflowWrap,wordBreak:s.wordBreak});
        mirror.textContent=t.value.slice(0,t.selectionEnd);
        caret.textContent='\u200b';mirror.append(caret);document.body.append(mirror);
        const mr=mirror.getBoundingClientRect(),cc=caret.getBoundingClientRect(),
          caretTop=cc.top-mr.top-t.scrollTop,caretBottom=cc.bottom-mr.top-t.scrollTop;
        mirror.remove();
        return {height:t.clientHeight,scrollHeight:t.scrollHeight,scrollTop:t.scrollTop,
          caretTop,caretBottom,
          lineHeight:line,resize:s.resize,top:r.top,bottom:r.bottom,
          footerTop:f.top,footerBottom:f.bottom,composerTop:cr.top,composerBottom:cr.bottom,
          transcriptBottom:document.querySelector('.otk-messages').getBoundingClientRect().bottom,
          composerScroll:c.scrollTop,documentScroll:document.scrollingElement.scrollTop,viewport:innerHeight};
      })()`);
    const samples = [];
    for (
      const [theme, suffix] of [["otk-dark", "dark"], ["otk-light", "light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await b.fill(input, "");
      const empty = await measure(), growing = [];
      if (shots) await b.screenshot(join(shots, `${suffix}-empty.png`));
      await b.send("Input.insertText", { text: "Draft line 1" });
      for (let n = 1; n <= 14; n++) {
        if (n > 1) {
          // Exercise the actual shared newline command and trusted typing.
          await b.key("Enter", 8);
          await b.send("Input.insertText", { text: `Draft line ${n}` });
        }
        await b.poll(
          `document.querySelector('${input}').value===${
            JSON.stringify(lines(n))
          }`,
        );
        const state = await measure();
        growing.push(state);
        if (shots && (n === 4 || n === 14)) {
          await b.screenshot(
            join(shots, `${suffix}-${n === 4 ? "four" : "cap"}.png`),
          );
        }
      }
      // Delete through the browser, including its native input event.
      await b.key("a", 2);
      await b.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
      await b.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
      });
      await b.poll(`document.querySelector('${input}').value===''`);
      samples.push({ theme, empty, growing, deleted: await measure() });
    }
    console.info("U13 native textarea geometry", samples);
    for (const { empty, growing, deleted } of samples) {
      assertEquals(empty.height, 48);
      assertEquals(deleted.height, empty.height);
      for (const [index, state] of growing.entries()) {
        assertEquals(state.lineHeight, 24);
        assertEquals(
          state.height,
          Math.min(240, Math.max(48, (index + 1) * 24)),
        );
        assertEquals(state.resize, "none");
        assertEquals(state.composerBottom, empty.composerBottom);
        assertEquals(state.footerTop, empty.footerTop);
        assertEquals(state.footerBottom, empty.footerBottom);
        assertEquals(
          state.composerTop,
          empty.composerTop - (state.height - empty.height),
        );
        assert(Math.abs(state.transcriptBottom - state.composerTop) < .5);
        assert(
          state.footerTop >= state.bottom &&
            state.footerBottom < state.viewport,
        );
        assertEquals([state.composerScroll, state.documentScroll], [0, 0]);
        assert(
          state.caretTop >= 0 && state.caretBottom <= state.height,
          "The actual selected caret line must fit inside the textarea viewport: " +
            JSON.stringify(state),
        );
        if (index >= 10) {
          assert(state.scrollHeight > state.height && state.scrollTop > 0);
        }
      }
    }

    // Soft wrapping must resize without a newline-counting JS owner, including
    // when the available lane width changes while the value stays untouched.
    const prose =
      "The composer follows the draft as its words wrap across the available lane. "
        .repeat(4);
    await b.fill(input, prose);
    const wide = await measure();
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1060,
      height: 657,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const narrow = await measure();
    assert(narrow.height > wide.height && narrow.height <= 240);
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 657,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assertEquals((await measure()).height, wide.height);

    // A programmatic editor replacement follows the same native sizing path.
    await b.click('[aria-label="Edit prompt"]');
    await b.poll(
      "!!document.querySelector('dialog[open] textarea[name=editor]')",
    );
    await b.fill("textarea[name=editor]", lines(4));
    await b.click(".otk-editor footer button:last-child");
    await b.poll(
      `!document.querySelector('dialog[open]') && document.querySelector('${input}').value===${
        JSON.stringify(lines(4))
      }`,
    );
    assertEquals((await measure()).height, 96);
    f.fake.queue({ chunks: ["Growing draft received."] });
    await b.click(".otk-prompt button[type=submit]");
    await b.poll(`document.querySelector('${input}').value===''`);
    assertEquals((await measure()).height, 48);
    await waitForReply(b, session.id, "Growing draft received.");
    const messages = await f.oc.request<
      { info: { role: string }; parts: { type: string; text?: string }[] }[]
    >(`/session/${session.id}/message`);
    assert(
      messages.some((row) =>
        row.info.role === "user" &&
        row.parts.some((part) => part.type === "text" && part.text === lines(4))
      ),
    );

    // Expanded drafts retain the same owner through chips and a takeover.
    await b.fill(input, lines(14));
    const pasted = lines(200);
    await b.evaluate(
      `(()=>{const t=document.querySelector('${input}');t.setSelectionRange(t.value.length,t.value.length);const d=new DataTransfer();d.setData('text/plain',${
        JSON.stringify(pasted)
      });t.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:d}));})()`,
    );
    await b.poll(
      "document.querySelector('.otk-prompt-chip')?.textContent.includes('200 lines')",
    );
    const retained = await b.evaluate<string>(
      `document.querySelector('${input}').value`,
    );
    assertEquals((await measure()).height, 240);
    await b.click(".otk-prompt-chip button");
    await b.poll(
      `document.querySelector('textarea[name=editor]')?.value===${
        JSON.stringify(pasted)
      }`,
    );
    await b.key("Escape");
    await b.poll("!document.querySelector('dialog[open]')");
    f.fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf u13-takeover",
          description: "Expanded draft takeover",
        },
      },
    }, { chunks: ["Takeover completed."] });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: {
        parts: [{
          type: "text",
          text:
            "Exercise the takeover without submitting the retained browser draft",
        }],
      },
    });
    await b.poll(
      "document.querySelector('.otk-permission-command')?.textContent==='printf u13-takeover' && document.querySelector('.otk-composer').hidden",
    );
    await b.click(".otk-permission-actions > button:first-child");
    await waitForReply(b, session.id, "Takeover completed.");
    await b.poll("!document.querySelector('.otk-composer').hidden");
    assertEquals(
      await b.evaluate(`document.querySelector('${input}').value`),
      retained,
    );
    assertEquals((await measure()).height, 240);
    assert(
      await b.evaluate(
        "document.querySelector('.otk-prompt-chip')?.textContent.includes('200 lines')",
      ),
    );
    // Removing the pasted-text chip leaves authored lines, then a real send
    // clears the expanded input and all of its attachments together.
    await b.click('.otk-prompt-chip button[aria-label^="Remove "]');
    await b.poll("!document.querySelector('.otk-prompt-chip')");
    assertEquals((await measure()).height, 240);
    f.fake.queue({ chunks: ["Expanded draft received."] });
    await b.click(".otk-prompt button[type=submit]");
    await b.poll(`document.querySelector('${input}').value===''`);
    assertEquals((await measure()).height, 48);
    await waitForReply(b, session.id, "Expanded draft received.");
  } finally {
    await client?.close();
    await f.stop();
  }
});
