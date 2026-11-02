// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  copySelection,
  nativeIdle,
  prompt,
  scrollTranscript,
  selectSourceWord,
  viewportSource as source,
} from "../../pages/transcript.ts";

test("messages.raw-tail-materialization-copy", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Raw tail endpoint",
  });
  await state.queue(["```ts\n" + source + "\n```\n"]);
  await state.native(`/session/${session.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Complete native raw source" }],
  });
  await nativeIdle(state, session.id);
  await page.addInitScript(`(()=>{
    globalThis.holdSourcePump=true;globalThis.sourcePump=[];
    const Native=MessageChannel;globalThis.MessageChannel=class extends Native {
      constructor(){super();const send=this.port2.postMessage.bind(this.port2);this.port2.postMessage=(value,...args)=>{if(holdSourcePump)sourcePump.push(()=>send(value,...args));else send(value,...args)}}
    };
    globalThis.releaseSourcePump=()=>{holdSourcePump=false;for(const send of sourcePump.splice(0))send()};
  })()`);
  await openSession(state, page, session.id);
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  await expect(page.locator(".otk-code-plain")).toBeAttached();
  await expect.poll(() => page.evaluate("sourcePump.length>0")).toBe(true);
  await scrollTranscript(page, true);
  await selectSourceWord(page, "viewport1999");
  await page.evaluate(
    "globalThis.tailAnchor=getSelection().anchorNode;globalThis.tailFocus=getSelection().focusNode;releaseSourcePump()",
  );
  await page.evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))",
  );
  expect(
    await page.evaluate(
      "getSelection().anchorNode===tailAnchor && getSelection().focusNode===tailFocus && tailAnchor.isConnected && tailFocus.isConnected",
    ),
  ).toBe(true);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    "viewport1999",
  );
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  await copySelection(page, "viewport1999");
  await page.locator(".otk-tabs-project").click();
  await expect(page.locator(".otk-token").filter({ hasText: /^viewport1999$/ }))
    .toHaveCount(1);
});

test("messages.far-colour-before-dense-source", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Demand before dense source",
  });
  await state.queue(["```ts\n" + source + "\n```\n"]);
  await state.native(`/session/${session.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Prepare demand source" }],
  });
  await nativeIdle(state, session.id);
  await page.addInitScript(`(()=>{
    globalThis.sourceTurnBudget=8;globalThis.pendingSourceTurns=[];globalThis.farProjection=false;
    const Channel=MessageChannel;globalThis.MessageChannel=class extends Channel {
      constructor(){super();const send=this.port2.postMessage.bind(this.port2);this.port2.postMessage=(value,...args)=>{const deliver=()=>send(value,...args);if(sourceTurnBudget-->0)deliver();else pendingSourceTurns.push(deliver)}}
    };
    const Native=Worker;globalThis.Worker=class extends Native {
      constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(data.type==='projection'&&data.tokens.some(token=>token.content==='viewport1999'))farProjection=true})}
    };
    globalThis.releaseSourceTurns=()=>{sourceTurnBudget=4;for(const deliver of pendingSourceTurns.splice(0))deliver()};
    globalThis.releaseAllSourceTurns=()=>{sourceTurnBudget=Infinity;for(const deliver of pendingSourceTurns.splice(0))deliver()};
  })()`);
  await openSession(state, page, session.id);
  await expect.poll(() =>
    page.evaluate("farProjection && pendingSourceTurns.length>0")
  ).toBe(true);
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  await page.evaluate("releaseSourceTurns()");
  await expect(page.locator(".otk-token").filter({ hasText: /^viewport1999$/ }))
    .toHaveCount(1, { timeout: 2000 });
  expect(await page.locator(".otk-code-group").count()).toBeLessThan(63);
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  await page.evaluate("releaseAllSourceTurns()");
  await expect(page.locator(".otk-code-plain")).toBeAttached();
  await expect(page.locator(".otk-token").filter({ hasText: /^viewport1999$/ }))
    .toHaveCount(1);
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  expect(
    await page.locator(".otk-code-group").evaluateAll((groups) =>
      groups.every((group) => {
        const text = group.textContent!;
        return (text.match(/\r\n|\n|\r/g)?.length || 0) +
            (/[\r\n]$/.test(text) ? 0 : 1) <= 32;
      })
    ),
  ).toBe(true);
  expect(
    await page.locator(".otk-code-plain").evaluateAll((rows) =>
      rows.some((raw) =>
        raw.textContent!.includes("viewport700") &&
        !raw.querySelector(".otk-token")
      )
    ),
  ).toBe(true);
});

test("messages.raw-selection-other-viewport-warms", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Selected raw source",
  });
  await state.queue(["```ts\n" + source + "\n```\n"]);
  await state.native(`/session/${session.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Prepare source" }],
  });
  await nativeIdle(state, session.id);
  await page.addInitScript(`(()=>{
    globalThis.heldHighlight=[];globalThis.holdHighlight=true;globalThis.sourceFocusEvidence=[];
    const Native=Worker;globalThis.Worker=class extends Native {
      constructor(...args){super(...args);this.addEventListener('message',event=>{if(holdHighlight){event.stopImmediatePropagation();heldHighlight.push({worker:this,data:event.data})}},true)}
      postMessage(value,...args){for(const request of Array.isArray(value)?value:[value]){const ranges=request.type==='focus'?request.ranges:request.focus;if(ranges?.length)sourceFocusEvidence.push({groups:document.querySelectorAll('.otk-code-group').length,tail:!!document.querySelector('.otk-code-plain'),ranges})}return super.postMessage(value,...args)}
    };
    globalThis.releaseHighlight=()=>{holdHighlight=false;for(const item of heldHighlight.splice(0))item.worker.dispatchEvent(new MessageEvent('message',{data:item.data}))};
  })()`);
  await openSession(state, page, session.id);
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  await expect.poll(() => page.evaluate("heldHighlight.length>0")).toBe(true);
  expect(
    await page.evaluate(
      "sourceFocusEvidence.some(entry=>entry.tail && entry.groups<63 && entry.ranges.length>0)",
    ),
  ).toBe(true);
  await scrollTranscript(page, false);
  await selectSourceWord(page, "viewport0");
  await page.evaluate(
    "globalThis.rawEndpoint=getSelection().anchorNode;releaseHighlight()",
  );
  await scrollTranscript(page, true);
  await expect(
    page.locator(".otk-code-group:last-child .otk-token").filter({
      hasText: /^viewport1999$/,
    }),
  ).toHaveCount(1);
  expect(
    await page.evaluate(
      "getSelection().anchorNode===rawEndpoint && rawEndpoint.isConnected",
    ),
  ).toBe(true);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    "viewport0",
  );
  await expect(page.locator(".otk-code-group:first-child .otk-token"))
    .toHaveCount(0);
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  await copySelection(page, "viewport0");
  await page.locator(".otk-tabs-project").click();
  await scrollTranscript(page, false);
  await expect(
    page.locator(".otk-code-group:first-child .otk-token").filter({
      hasText: /^viewport0$/,
    }),
  ).toHaveCount(1);
});

test("messages.atomic-append-selected-endpoints", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Atomic source append",
  });
  await page.addInitScript(`(()=>{
    globalThis.atomicFailures=[];globalThis.expectedCode='';globalThis.expectedMarker='';
    new MutationObserver(()=>{const code=[...document.querySelectorAll('.otk-code code')].at(-1);if(code&&[...document.querySelectorAll('.otk-text p')].some(p=>p.textContent===expectedMarker)&&code.textContent!==expectedCode)atomicFailures.push({code:code.textContent,expected:expectedCode})}).observe(document,{subtree:true,childList:true,characterData:true});
    globalThis.holdTokens=false;globalThis.heldTokens=[];
    const Native=Worker;globalThis.Worker=class extends Native{constructor(...args){super(...args);this.addEventListener('message',event=>{if(holdTokens&&event.data.tokens){event.stopImmediatePropagation();heldTokens.push({worker:this,data:event.data})}},true)}};
    globalThis.releaseTokens=()=>{holdTokens=false;for(const item of heldTokens.splice(0))item.worker.dispatchEvent(new MessageEvent('message',{data:item.data}))};
  })()`);
  await openSession(state, page, session.id);
  for (const mode of ["atomic", "raw", "styled"]) {
    const word = mode + "Word",
      first = "const " + word,
      final = first + "Name: number = 9;",
      marker = mode + " source committed.";
    await page.evaluate(
      `expectedCode=${JSON.stringify(final)};expectedMarker=${
        JSON.stringify(marker)
      };holdTokens=${mode === "raw"};atomicFailures=[]`,
    );
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: ["```ts\n" + first, "Name: number = 9;\n```\n" + marker],
      delay: 1400,
    });
    await prompt(page, "Append " + mode + " source");
    await expect(page.locator(".otk-code code").last()).toHaveJSProperty(
      "textContent",
      first,
    );
    if (mode === "raw") {
      await expect.poll(() => page.evaluate("heldTokens.length>0")).toBe(true);
    } else {await expect(
        page.locator(".otk-token").filter({
          hasText: new RegExp("^" + word + "$"),
        }),
      ).toHaveCount(1);}
    if (mode !== "atomic") {
      await selectSourceWord(page, word, true);
      await page.evaluate(
        "globalThis.appendEndpoint=getSelection().anchorNode;globalThis.appendCode=[...document.querySelectorAll('.otk-code code')].at(-1);globalThis.appendMessage=appendCode.closest('.otk-message')",
      );
    }
    await expect(page.locator(".otk-text p").filter({ hasText: marker }))
      .toHaveCount(1);
    await expect(
      page.locator(`.otk-project-sessions [data-session="${session.id}"]`),
    ).toHaveAttribute("data-status", "idle");
    await expect(page.locator(".otk-code code").last()).toHaveJSProperty(
      "textContent",
      final,
    );
    expect(await page.evaluate("atomicFailures")).toEqual([]);
    if (mode !== "atomic") {
      expect(
        await page.evaluate(
          "getSelection().anchorNode===appendEndpoint && appendEndpoint.isConnected",
        ),
        await page.evaluate(
          "JSON.stringify({messageConnected:appendMessage.isConnected,codeConnected:appendCode.isConnected,endpointConnected:appendEndpoint.isConnected})",
        ),
      ).toBe(true);
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(word);
      await copySelection(page, word);
    }
    if (mode === "raw") await page.evaluate("releaseTokens()");
    await page.locator(".otk-tabs-project").click();
    await expect(
      page.locator(".otk-token").filter({
        hasText: new RegExp("^" + word + "Name$"),
      }),
    ).toHaveCount(1);
  }
});
