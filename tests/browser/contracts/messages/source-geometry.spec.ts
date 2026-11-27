// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { viewByUrl } from "../../pages/sessions.ts";
import {
  copySelection,
  nativeIdle,
  openWork,
  prompt,
  revealAcquired,
  scrollTranscript,
  scrollViewport,
  selectSourceWord,
  sessionStatus,
  showFileChanges,
  toolScript,
  viewportSource as source,
  wheelTranscript,
  wheelViewport,
  workPanel,
} from "../../pages/transcript.ts";
import type { Page } from "@playwright/test";

const completedWrite = '[data-tool="write"][data-tool-status="completed"]';
const workList = (page: Page) => workPanel(page).locator(".otk-work-list");

// A mounted fold is not source readiness. Borrow the delivered tool's identity
// before opening its own work groups, including across virtual replacement.
async function revealWrite(page: Page, sessionID: string) {
  let messageID: string | undefined;
  await expect.poll(async () => {
    messageID = await page.evaluate((sessionID) => {
      const messages = (globalThis as typeof globalThis & {
        transcriptPublication: Map<string, import("@otk/protocol").Message>;
      }).transcriptPublication;
      return [...messages.values()].find((message) =>
        message.sessionID === sessionID &&
        message.parts.some((part) =>
          part.kind === "tool" && part.call.tool === "write" &&
          part.call.status === "completed"
        )
      )?.id;
    }, sessionID);
    return messageID;
  }).toBeTruthy();
  const selector = `[data-message="${messageID}"]`;
  await revealAcquired(page, selector);
  const panel = await openWork(page.locator(selector));
  await expect(panel.locator(completedWrite)).toBeVisible();
}

test("messages.numbered-source-acquires-published-write-owner", {
  tag: ["@messages", "@contracts"],
}, async ({ page }) => {
  await page.setContent(
    `<div class="otk-messages" aria-busy="false" style="height:200px;overflow:auto"><article data-message="earlier"><button class="otk-work-strip" aria-current="true"><span>Work log</span></button></article></div><section id="otk-panel-content" aria-label="Work log">Earlier work</section>`,
  );
  await page.evaluate(() => {
    Object.assign(globalThis, { transcriptPublication: new Map() });
  });
  let settled = false;
  const acquisition = revealWrite(page, "shape-session").then(() => {
    settled = true;
  });
  try {
    // The old readiness condition can finish while the requested source is held.
    // Join it explicitly, not a sleep or a guessed number of quiet frames.
    await expect(workPanel(page)).toHaveText("Earlier work");
    expect(settled, "An earlier open fold cannot certify the write").toBe(
      false,
    );
  } finally {
    await page.evaluate(() => {
      const messages = (globalThis as typeof globalThis & {
        transcriptPublication: Map<string, unknown>;
      }).transcriptPublication;
      messages.set("written", {
        id: "written",
        sessionID: "shape-session",
        parts: [{
          kind: "tool",
          call: { tool: "write", status: "completed" },
        }],
      });
      document.querySelector(".otk-messages")!.insertAdjacentHTML(
        "beforeend",
        `<article data-message="written"><button class="otk-work-strip" onclick="document.querySelector('.otk-work-strip[aria-current]').removeAttribute('aria-current');this.setAttribute('aria-current','true');document.getElementById('otk-panel-content').replaceChildren(this.nextElementSibling.content.cloneNode(true))"><span>Work log</span></button><template><section data-tool="write" data-tool-status="completed"><code>Written source</code></section></template></article>`,
      );
    });
    await acquisition;
  }
  await expect(workPanel(page).locator("code")).toHaveText(
    "Written source",
  );
});

// Native source coordinates cover both preformatted text and styled rows. The
// independent probe deliberately does not import product geometry machinery.
const sourceGeometry = String.raw`(code,index)=>{
  const text=code.textContent,endings=[...text.matchAll(/\r\n|\n|\r/g)];
  const start=index===0?0:endings[index-1].index+endings[index-1][0].length,end=endings[index]?.index??text.length;
  const point=offset=>{const walk=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);let node,last,n=0;while(node=walk.nextNode()){last=node;if(n+node.textContent.length>offset)return {node,offset:offset-n};n+=node.textContent.length;}return {node:last,offset:last?.textContent.length??0}};
  const a=point(start);let glyph,box,height;
  if(end>start){const b=point(start+1),range=document.createRange();range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);const ink=range.getBoundingClientRect();glyph=ink.y+ink.height/2;}
  if(start===text.length&&end===start){const row=[...code.querySelectorAll('.otk-code-line')].at(-1);box=row.getBoundingClientRect();height=box.height;}
  else {
    const row=a.node.parentElement.closest('.otk-code-line');
    if(row){box=row.getBoundingClientRect();height=box.height;}
    else {
      const raw=a.node.parentElement.closest('.otk-code-raw,.otk-code-plain'),rect=raw.getBoundingClientRect(),body=raw.textContent,lines=[...body.matchAll(/\r\n|\n|\r/g)],count=lines.length+(/[^\r\n]$/.test(body)?1:0);
      const before=document.createRange();before.setStart(raw,0);before.setEnd(a.node,a.offset);const local=[...before.toString().matchAll(/\r\n|\n|\r/g)].length;
      height=rect.height/count;box={y:rect.y+local*height,height,top:rect.y+local*height,bottom:rect.y+(local+1)*height};
    }
  }
  return {index,row:box.y+box.height/2,glyph,height,lineHeight:parseFloat(getComputedStyle(code.parentElement).lineHeight),top:box.top,bottom:box.bottom};
}`;

async function revealLine(page: Page, index: number) {
  const delta = await page.evaluate<number>(
    `(()=>{const pane=document.querySelector('.otk-work-list'),box=pane.getBoundingClientRect(),code=pane.querySelector('.otk-code code'),row=(${sourceGeometry})(code,${index});return row.row-box.top-box.height/2})()`,
  );
  if (Math.abs(delta) >= 1) await wheelViewport(workList(page), delta);
  await expect.poll(() =>
    page.evaluate(
      `(()=>{const pane=document.querySelector('.otk-work-list'),box=pane.getBoundingClientRect(),row=(${sourceGeometry})(pane.querySelector('.otk-code code'),${index});return row.row>box.top&&row.row<box.bottom})()`,
    )
  ).toBe(true);
}

test("messages.code-projection-copy-numbered-geometry", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page }) => {
  test.setTimeout(180_000);
  const markdown = await state.native<{ id: string }>("/session", "POST", {
    title: "Viewport markdown",
  });
  const write = await state.native<{ id: string }>("/session", "POST", {
    title: "Viewport write",
  });
  await state.queue(["```ts\n" + source + "\n```\n"]);
  await state.native(`/session/${markdown.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Viewport source" }],
  });
  await nativeIdle(state, markdown.id);
  await openSession(state, page, markdown.id);
  await showFileChanges(state, page);
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  await expect(page.locator(".otk-code-plain")).toBeAttached({
    timeout: 60_000,
  });
  await scrollTranscript(page, false);
  await expect(
    page.locator(".otk-code-group:first-child .otk-token").filter({
      hasText: /^viewport0$/,
    }),
  ).toHaveCount(1);
  await expect(page.locator(".otk-code-group:last-child .otk-token"))
    .toHaveCount(0);
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  const prefix = await page.locator(".otk-code-group:first-child .otk-token")
    .evaluateAll((tokens) =>
      tokens.slice(0, 8).map((token) => ({
        text: token.textContent,
        color: getComputedStyle(token).color,
      }))
    );
  await selectSourceWord(page, "viewport0");
  await scrollTranscript(page, true);
  await expect(
    page.locator(".otk-code-group:last-child .otk-token").filter({
      hasText: /^viewport1999$/,
    }),
  ).toHaveCount(1);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    "viewport0",
  );
  expect(
    await page.locator(".otk-code-group:first-child .otk-token").evaluateAll(
      (tokens) =>
        tokens.slice(0, 8).map((token) => ({
          text: token.textContent,
          color: getComputedStyle(token).color,
        })),
    ),
  ).toEqual(prefix);
  await copySelection(page, "viewport0");
  // Release native text selection on inert chrome, not the new menu button.
  await page.locator(".otk-task-strip").click({
    position: await page.locator(".otk-task-strip").evaluate((el) => ({
      x: el.clientWidth / 2,
      y: 1,
    })),
    timeout: 10_000,
  });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  await expect(page.locator(".otk-code-group:first-child .otk-token"))
    .toHaveCount(0);
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  const nativeText = await page.locator("body").innerText();
  expect(nativeText).toContain("const viewport0: number = 0;");
  expect(nativeText).toContain("const viewport1999: number = 1999;");
  expect(
    await page.evaluate(
      "(()=>{const code=document.querySelector('.otk-code code'),walk=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);let node;while(node=walk.nextNode()){if(node.textContent.includes('viewport700'))return !node.parentElement.closest('.otk-code-plain,.otk-code-raw')||!!node.parentElement.closest('.otk-token')}throw new Error('Missing cold native source')})()",
    ),
  ).toBe(false);
  await toolScript(state, "write", {
    filePath: state.directory + "/viewport.ts",
    content: source,
  }, "Written source.");
  await state.native(`/session/${write.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Write viewport source" }],
  });
  await nativeIdle(state, write.id);
  await openSession(state, page, write.id);
  await revealWrite(page, write.id);
  await expect(page.locator(".otk-code[data-numbered=true] code"))
    .toHaveJSProperty("textContent", source);
  await expect(page.locator(".otk-code-plain")).toBeAttached({
    timeout: 60_000,
  });
  await scrollViewport(workList(page), true);
  await revealLine(page, 1999);
  await expect(page.locator(".otk-token").filter({ hasText: /^viewport1999$/ }))
    .toHaveCount(1);
  const geometry = await page.evaluate(`(()=>{
    const code=document.querySelector('.otk-code'),probe=${sourceGeometry},walker=document.createTreeWalker(code.querySelector('.otk-code-numbers'),NodeFilter.SHOW_TEXT),numbers=walker.nextNode();
    return [0,126,1999].map(index=>{const row=probe(code.querySelector('code'),index),text=numbers.textContent,offset=text.split('\\n').slice(0,index).reduce((n,line)=>n+line.length+1,0),range=document.createRange();range.setStart(numbers,offset);range.setEnd(numbers,offset+String(index+1).length);const g=range.getBoundingClientRect();return {...row,number:g.y+g.height/2}});
  })()`) as {
    index: number;
    row: number;
    number: number;
    glyph?: number;
    height: number;
    lineHeight: number;
  }[];
  for (const row of geometry) {
    expect(
      row.glyph !== undefined
        ? Math.abs(row.glyph - row.number) <= .5
        : Math.abs(
              (row.row - geometry[0].row) - (row.number - geometry[0].number),
            ) <= .5 && Math.abs(row.height - row.lineHeight) <= .5,
      JSON.stringify(row),
    ).toBe(true);
  }
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
});

test("messages.leading-clip-true-colour-gutter", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Leading clipped source",
  });
  await openSession(state, page, session.id);
  await showFileChanges(state, page);
  await toolScript(state, "write", {
    filePath: state.directory + "/leading.ts",
    content: source,
  }, "Written.");
  await prompt(page, "Write leading clipped source");
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await revealWrite(page, session.id);
  await scrollViewport(workList(page), true);
  await expect(page.locator(".otk-token").filter({ hasText: /^viewport1999$/ }))
    .toHaveCount(1);
  const delta = await page.evaluate<number>(
    `(()=>{const pane=document.querySelector('.otk-work-list'),box=pane.getBoundingClientRect(),code=pane.querySelector('.otk-code code'),row=(${sourceGeometry})(code,1983);return row.top-box.top-pane.clientTop})()`,
  );
  await wheelViewport(workList(page), delta);
  await expect.poll(() =>
    page.evaluate(
      `(()=>{const pane=document.querySelector('.otk-work-list'),box=pane.getBoundingClientRect(),code=pane.querySelector('.otk-code code'),row=(${sourceGeometry})(code,1983);return row.top>=box.top-.5&&row.bottom<=box.bottom+.5})()`,
    )
  ).toBe(true);
  await expect(page.locator(".otk-token").filter({ hasText: /^viewport1983$/ }))
    .toHaveCount(1, { timeout: 3000 });
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    source,
  );
  const alignment = await page.evaluate(
    `(()=>{const block=document.querySelector('.otk-code'),row=(${sourceGeometry})(block.querySelector('code'),1983),numbers=block.querySelector('.otk-code-numbers').firstChild,text=numbers.textContent,offset=text.split('\\n').slice(0,1983).reduce((n,line)=>n+line.length+1,0),range=document.createRange();range.setStart(numbers,offset);range.setEnd(numbers,offset+4);const box=range.getBoundingClientRect();return Math.abs(row.glyph-(box.y+box.height/2))})()`,
  );
  expect(alignment).toBeLessThanOrEqual(.5);
});

test("messages.numbered-empty-blank-terminal-geometry", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(String.raw`(()=>{
    const nativeRow=${sourceGeometry};
    globalThis.shapeSamples=[];globalThis.heldShape=[];globalThis.holdShape=true;globalThis.shapeExpected='';globalThis.shapeTargets=[];
    const Native=Worker;globalThis.Worker=class extends Native{constructor(...args){super(...args);this.addEventListener('message',event=>{if(holdShape&&event.data.tokens){event.stopImmediatePropagation();heldShape.push({worker:this,data:event.data})}},true)}};
    globalThis.releaseShape=()=>{holdShape=false;for(const item of heldShape.splice(0))item.worker.dispatchEvent(new MessageEvent('message',{data:item.data}))};
    globalThis.measureShape=()=>{
      const block=document.querySelector('.otk-code[data-numbered=true]');if(!block)return;
      const code=block.querySelector('code'),rows=[...code.querySelectorAll('.otk-code-line')],numbers=block.querySelector('.otk-code-numbers'),walker=document.createTreeWalker(numbers,NodeFilter.SHOW_TEXT);const numberNode=walker.nextNode();
      if(!numberNode||numberNode.textContent.split('\n').length!==shapeExpected.split(/\r\n|\n|\r/).length)return;
      const glyph=(root,word)=>{const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let text;while(text=walk.nextNode()){if(text.parentElement.closest('.otk-code-newline'))continue;const offset=text.textContent.indexOf(word);if(offset>=0){const r=document.createRange();r.setStart(text,offset);r.setEnd(text,offset+word.length);const box=r.getBoundingClientRect();return box.y+box.height/2;}}};
      const centres=shapeTargets.map(({word,index})=>{const offset=index===0?0:numberNode.textContent.lastIndexOf(String(index+1)),range=document.createRange();range.setStart(numberNode,offset);range.setEnd(numberNode,offset+String(index+1).length);const r=range.getBoundingClientRect();return {index,code:glyph(code,word),number:r.y+r.height/2}});
      const flat=[...code.querySelectorAll('.otk-code-raw')].map(raw=>raw.getBoundingClientRect().height/[...raw.textContent.matchAll(/\r\n|\n|\r/g)].length);
      const logical=shapeExpected.split(/\r\n|\n|\r/),indices=[...new Set([0,logical.findIndex(line=>line===''),logical.length-1])].filter(index=>index>=0);
      const positions=code.textContent===shapeExpected?indices.map(index=>{const row=nativeRow(code,index),offset=numberNode.textContent.split('\n').slice(0,index).reduce((n,line)=>n+line.length+1,0),range=document.createRange();range.setStart(numberNode,offset);range.setEnd(numberNode,offset+String(index+1).length);const r=range.getBoundingClientRect();return {...row,number:r.y+r.height/2}}):[];
      const bounded=[...code.querySelectorAll('.otk-code-group')].every(group=>{const text=group.textContent;return (text.match(/\r\n|\n|\r/g)?.length||0)+(/[\r\n]$/.test(text)?0:1)<=32});
      shapeSamples.push({exact:code.textContent===shapeExpected,bounded,groups:code.querySelectorAll('.otk-code-group').length,tokens:code.querySelectorAll('.otk-token').length,centres,positions,rowHeights:[...rows.map(row=>row.getBoundingClientRect().height),...flat],lineHeight:parseFloat(getComputedStyle(code.parentElement).lineHeight)});
    };
    new MutationObserver(measureShape).observe(document,{subtree:true,childList:true,characterData:true});
  })()`);
  const big = Array.from({ length: 2000 }, (_, i) =>
    i === 126
      ? ""
      : i === 1999
      ? "const finalShape = 1999;"
      : `const shape${i} = ${i};`).join("\r\n") + "\r\n";
  for (
    const [index, content, targets] of [
      [0, "", []],
      [1, "const small = 1;\r\n\r\nconst end = 2;\r\n", [{
        word: "small",
        index: 0,
      }, { word: "end", index: 2 }]],
      [2, big, [{ word: "shape0", index: 0 }, {
        word: "finalShape",
        index: 1999,
      }]],
    ] as const
  ) {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Natural shape " + index,
    });
    if (index === 0) {
      await openSession(state, page, session.id);
    } else {
      // D74 / wl-5: leave the previous reply's Work pane by session link.
      // This probe measures source geometry, not catalog admission of a new row.
      await viewByUrl(state, page, session.id);
      await expect(
        page.getByRole("region", { name: "Transcript", exact: true }),
      )
        .toHaveAttribute("aria-busy", "false");
    }
    await page.evaluate(() =>
      document.fonts.ready
    );
    if (index === 0) {
      await showFileChanges(state, page);
    }
    await page.evaluate(
      `shapeSamples=[];heldShape=[];holdShape=true;shapeExpected=${
        JSON.stringify(content)
      };shapeTargets=${JSON.stringify(targets)}`,
    );
    await toolScript(state, "write", {
      filePath: state.directory + "/shape-" + index + ".ts",
      content,
    }, "Written.");
    await prompt(page, "Write shape " + index);
    await revealWrite(page, session.id);
    await expect(page.locator(".otk-code[data-numbered=true] code"))
      .toHaveJSProperty("textContent", content);
    await expect.poll(() =>
      page.locator(".otk-code-group").count()
    )
      .toBeGreaterThan(0);
    await expect.poll(() => page.evaluate("heldShape.length>0")).toBe(true);
    await page.evaluate("measureShape();releaseShape()");
    if (targets.length) {
      await scrollViewport(workList(page), true);
      await revealLine(page, targets.at(-1)!.index);
      await expect(
        page.locator(".otk-token").filter({
          hasText: new RegExp("^" + targets.at(-1)!.word + "$"),
        }),
      ).toHaveCount(1);
    }
    await page.evaluate("measureShape()");
    const samples = await page.evaluate("shapeSamples") as {
      exact: boolean;
      bounded: boolean;
      groups: number;
      tokens: number;
      centres: { code?: number; number: number }[];
      positions: { row: number; number: number; height: number }[];
      rowHeights: number[];
      lineHeight: number;
    }[];
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.bounded, "Source group exceeded 32 logical rows").toBe(
        true,
      );
      expect(sample.exact, "Raw/grouped/styled source bytes changed").toBe(
        true,
      );
      for (const centre of sample.centres) {
        expect(
          centre.code !== undefined &&
            Math.abs(centre.code - centre.number) <= .5,
          JSON.stringify(centre),
        ).toBe(true);
      }
      for (const height of sample.rowHeights) {
        expect(
          Math.abs(height - sample.lineHeight),
          "Logical row height changed",
        ).toBeLessThanOrEqual(.5);
      }
      expect(sample.positions.length).toBeGreaterThan(0);
      for (const row of sample.positions) {
        expect(
          Math.abs(
                (row.row - sample.positions[0].row) -
                  (row.number - sample.positions[0].number),
              ) <= .5 && Math.abs(row.height - sample.lineHeight) <= .5,
          JSON.stringify(row),
        ).toBe(true);
      }
    }
    if (index === 2) {
      expect(
        samples.some((sample) => sample.groups === 1 && sample.tokens === 0),
      ).toBe(true);
      expect(samples.some((sample) => sample.groups > 1 && sample.tokens > 0))
        .toBe(true);
    }
    await sessionStatus(page, session.id, "idle");
    // Reading in the Work panel must leave the conversation available in its
    // independent viewport.
    await scrollTranscript(page, false);
    const prose = page.locator(".otk-text p").filter({
      hasText: /^Written\.$/,
    });
    await expect(prose).toHaveCount(1);
    await expect(prose).toBeInViewport();
  }
});

test("messages.batch-grammar-recalled-tail", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Batch grammar and recall",
  });
  await openSession(state, page, session.id);
  const rows = Array.from(
    { length: 70 },
    (_, i) =>
      i === 30
        ? "/* opened batch comment"
        : i === 31 || i === 32
        ? `comment across batch ${i}`
        : i > 32 && i < 64
        ? `comment line ${i}`
        : i === 64
        ? "*/"
        : `const batch${i}: number = ${i};`,
  );
  const first = rows.join("\n") + "\nconst recalled",
    final = first + "Name: number = 9;\nconst afterRecall: number = 1;";
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [
      "```ts\n" + first,
      "Name: number = 9;\nconst afterRecall: number = 1;\n```\n",
    ],
    delay: 1200,
  });
  await prompt(page, "Cross completed batches and recall the tail");
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    first,
  );
  await expect(page.locator(".otk-token").filter({ hasText: /^recalled$/ }))
    .toHaveCount(1);
  await page.evaluate(
    "globalThis.measuredCode=document.querySelector('.otk-code')",
  );
  const before = await page.locator(".otk-token").filter({
    hasText: /^recalled$/,
  }).evaluate((token) => getComputedStyle(token).color);
  const delta = await page.evaluate<number>(
    `(()=>{const pane=document.querySelector('.otk-messages'),r=pane.getBoundingClientRect(),code=document.querySelector('.otk-code code'),probe=${sourceGeometry},a=probe(code,31),b=probe(code,32);return (a.top+b.bottom)/2-(r.top+r.bottom)/2})()`,
  );
  await wheelTranscript(page, delta);
  await expect.poll(() =>
    page.evaluate(
      `(()=>{const p=document.querySelector('.otk-messages').getBoundingClientRect(),code=document.querySelector('.otk-code code'),probe=${sourceGeometry};return [31,32].every(i=>{const r=probe(code,i);return r.top>=p.top&&r.bottom<=p.bottom})})()`,
    )
  ).toBe(true);
  const commentColor = await page.evaluate(
    "(()=>{const sample=document.createElement('span');sample.style.color='var(--otk-code-comment)';document.body.append(sample);const color=getComputedStyle(sample).color;sample.remove();return color})()",
  );
  for (const index of [31, 32]) {
    const token = page.locator(".otk-token").filter({
      hasText: `comment across batch ${index}`,
    });
    await expect(token).toHaveCount(1);
    expect(await token.evaluate((element) => getComputedStyle(element).color))
      .toBe(commentColor);
    await expect(token).toHaveAttribute("style", /--otk-syntax-token-comment/);
  }
  await scrollTranscript(page, true);
  await expect(page.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    final,
  );
  await expect(page.locator(".otk-token").filter({ hasText: /^recalledName$/ }))
    .toHaveCount(1);
  expect(
    await page.evaluate(
      "globalThis.measuredCode.isConnected && globalThis.measuredCode===document.querySelector('.otk-code')",
    ),
  ).toBe(true);
  expect(
    await page.locator(".otk-token").filter({ hasText: /^recalledName$/ })
      .evaluate((token) => getComputedStyle(token).color),
  ).toBe(before);
  await expect(page.locator(".otk-token").filter({ hasText: /^recalled$/ }))
    .toHaveCount(0);
  expect(
    await page.locator(".otk-token").filter({ hasText: /^afterRecall$/ })
      .evaluate((token) => getComputedStyle(token).color),
  ).toBe(before);
});
