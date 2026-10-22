// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { Cdp } from "../support/cdp.ts";
import { waitFor } from "../support/opencode.ts";

const source = Array.from(
  { length: 2000 },
  (_, i) => i % 127 === 126 ? "" : `const viewport${i}: number = ${i};`,
).join("\n");

// These tests measure expanded write content. Exercise that Display mode while
// the dedicated disclosure tests retain coverage of the default collapsed mode.
async function showFileChanges(browser: Cdp) {
  await browser.click(".otk-display-menu > button");
  await browser.poll(
    "document.querySelector('input[name=collapseFileChanges]')?.checked===true",
  );
  const frameStart = browser.events.length;
  await browser.click("input[name=collapseFileChanges]");
  await browser.poll(
    "document.querySelector('input[name=collapseFileChanges]')?.checked===false",
  );
  // Native checked state precedes the authoritative preference broadcast.
  await waitFor(
    () =>
      browser.events.slice(frameStart).some((event) => {
        if (event.method !== "Network.webSocketFrameReceived") return false;
        const frame = JSON.parse(
          (event.params.response as { payloadData: string }).payloadData,
        );
        return frame.t === "prefs" && frame.prefs.collapseFileChanges === false;
      }),
    (received) => received,
  );
  await browser.key("Escape");
  // Some callers configure Display before creating their first write. Any
  // already-mounted code must also have reached its expanded consumer state.
  await browser.poll(
    "[...document.querySelectorAll('[data-tool=write] .otk-code code')].every(code=>!code.closest('[hidden]') && code.getBoundingClientRect().height>0)",
  );
}

// Native source coordinates work for both preformatted text and styled rows.
// A logical unstyled line need not be represented by a separate element.
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

test("programmatic reveal keeps a transcript action in place for its real click", async () => {
  const f = await browserFixture({ task: "allow" });
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Reveal without follow feedback" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    for (const name of ["First reveal", "Second reveal"]) {
      f.fake.queue(
        {
          tool: {
            name: "task",
            input: {
              subagent_type: "general",
              description: name,
              prompt: name,
            },
          },
        },
        { chunks: [name + " child done."] },
        { chunks: [name + " parent done."] },
      );
      await browser.type("textarea[name=prompt]", name);
      await browser.key("Enter");
      await browser.poll(
        `document.querySelector('[data-session="${session.id}"]').dataset.status==='idle' && [...document.querySelectorAll('[data-tool=task][data-tool-status=completed]')].some(el=>el.textContent.includes(${
          JSON.stringify(name)
        }))`,
      );
    }
    const children = await f.oc.request<{ id: string; title: string }[]>(
      `/session/${session.id}/children`,
    );
    const first = children.find((child) =>
      child.title.includes("First reveal")
    )!;
    const point = await browser.evaluate<
      { x: number; y: number; before: number; after: number; inView: boolean }
    >(`(async()=>{
      const action=document.querySelector('.otk-task-card'),pane=document.querySelector('.otk-messages');
      action.scrollIntoView({block:'center',inline:'nearest'});
      const before=pane.scrollTop;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const r=action.getBoundingClientRect(),p=pane.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2,before,after:pane.scrollTop,inView:r.y+r.height/2>p.y&&r.y+r.height/2<p.bottom};
    })()`);
    assert(
      point.inView && Math.abs(point.before - point.after) <= .5,
      JSON.stringify(point),
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await browser.send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await browser.poll(
      `location.hash==='#/local/${session.id}/${first.id}' && document.querySelector('.otk-subagent-bar')?.textContent.includes('First reveal') && !document.querySelector('.otk-prompt')`,
    );
  } finally {
    await f.stop();
  }
});

test("actual busy rendering prepares one worker and idle plaintext releases it without code markers", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Rendering capability lifetime" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    const reply = f.fake.queueHeld({
      chunks: [
        "Plain activity ",
        "continues ",
        "without code ",
        "and finishes.",
      ],
      delay: 400,
    });
    await browser.type(
      "textarea[name=prompt]",
      "Observe a real plaintext reply",
    );
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status==='busy'`,
    );
    await waitFor(
      () => browser.send("Target.getTargets"),
      (targets) =>
        (targets.targetInfos as { type: string }[]).some((target) =>
          target.type === "worker"
        ),
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-code,.otk-token').length",
      ),
      0,
    );
    reply.release();
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status==='idle' && document.querySelector('.otk-messages').textContent.includes('Plain activity continues without code and finishes.')`,
    );
    await waitFor(
      () => browser.send("Target.getTargets"),
      (targets) =>
        !(targets.targetInfos as { type: string }[]).some((target) =>
          target.type === "worker"
        ),
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-code,.otk-token').length",
      ),
      0,
    );
  } finally {
    await f.stop();
  }
});

test("selected complete raw-tail endpoints survive source materialization and real copy", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Raw tail endpoint" },
    });
    f.fake.queue({ chunks: ["```ts\n" + source + "\n```\n"] });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Complete native raw source" }] },
    });
    await waitFor(
      () =>
        f.oc.request<
          { info: { role: string; time: { completed?: number } } }[]
        >(`/session/${session.id}/message`),
      (messages) =>
        messages.some((message) =>
          message.info.role === "assistant" && !!message.info.time.completed
        ),
    );
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(()=>{
      globalThis.holdSourcePump=true;globalThis.sourcePump=[];
      const Native=MessageChannel;globalThis.MessageChannel=class extends Native {
        constructor(){super();const send=this.port2.postMessage.bind(this.port2);this.port2.postMessage=(value,...args)=>{if(holdSourcePump)sourcePump.push(()=>send(value,...args));else send(value,...args)}}
      };
      globalThis.releaseSourcePump=()=>{holdSourcePump=false;for(const send of sourcePump.splice(0))send()};
    })()`,
    });
    await browser.goto(server.url);
    await openSession(browser, session.id);
    await browser.poll(
      `document.querySelector('.otk-code code')?.textContent===${
        JSON.stringify(source)
      } && !!document.querySelector('.otk-code-plain') && sourcePump.length>0`,
    );
    await scroll(browser, true);
    const point = await browser.evaluate<{ x: number; y: number }>(
      `(()=>{const tail=document.querySelector('.otk-code-plain'),walk=document.createTreeWalker(tail,NodeFilter.SHOW_TEXT);let node;while(node=walk.nextNode()){const at=node.textContent.indexOf('viewport1999');if(at>=0){const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+12);const r=range.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}}throw new Error('No complete raw tail word')})()`,
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await browser.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 2,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await browser.poll("getSelection().toString()==='viewport1999'");
    await browser.evaluate(
      "globalThis.tailAnchor=getSelection().anchorNode;globalThis.tailFocus=getSelection().focusNode;releaseSourcePump()",
    );
    await browser.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))",
    );
    assertEquals(
      await browser.evaluate(
        "getSelection().anchorNode===tailAnchor && getSelection().focusNode===tailFocus && tailAnchor.isConnected && tailFocus.isConnected",
      ),
      true,
    );
    assertEquals(
      await browser.evaluate("getSelection().toString()"),
      "viewport1999",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-code code').textContent",
      ),
      source,
    );
    await browser.send("Browser.grantPermissions", {
      origin: server.url,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await browser.key("c", 2);
    await browser.poll(
      "navigator.clipboard.readText().then(text=>text==='viewport1999')",
    );
    await browser.click(".otk-tabs-project");
    await browser.poll(
      "[...document.querySelectorAll('.otk-token')].some(token=>token.textContent==='viewport1999')",
    );
  } finally {
    await f.stop();
  }
});

test("genuine far-viewport colour does not wait for dense cold-source materialization", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Demand before dense source" },
    });
    f.fake.queue({ chunks: ["```ts\n" + source + "\n```\n"] });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Prepare demand source" }] },
    });
    await waitFor(
      () =>
        f.oc.request<{ info: { time: { completed?: number } } }[]>(
          `/session/${session.id}/message`,
        ),
      (messages) => messages.some((message) => !!message.info.time.completed),
    );
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(()=>{
        globalThis.sourceTurnBudget=8;globalThis.pendingSourceTurns=[];globalThis.farProjection=false;
        const Channel=MessageChannel;globalThis.MessageChannel=class extends Channel {
          constructor(){super();const send=this.port2.postMessage.bind(this.port2);this.port2.postMessage=(value,...args)=>{const deliver=()=>send(value,...args);if(sourceTurnBudget-->0)deliver();else pendingSourceTurns.push(deliver)}}
        };
        const Native=Worker;globalThis.Worker=class extends Native {
          constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(data.type==='projection'&&data.tokens.some(token=>token.content==='viewport1999'))farProjection=true})}
        };
        globalThis.releaseSourceTurns=()=>{sourceTurnBudget=4;for(const deliver of pendingSourceTurns.splice(0))deliver()};
        globalThis.releaseAllSourceTurns=()=>{sourceTurnBudget=Infinity;for(const deliver of pendingSourceTurns.splice(0))deliver()};
      })()`,
    });
    await browser.goto(server.url);
    await openSession(browser, session.id);
    await browser.poll("farProjection && pendingSourceTurns.length>0");
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-code code').textContent",
      ),
      source,
    );
    await browser.evaluate("releaseSourceTurns()");
    await browser.poll(
      "[...document.querySelectorAll('.otk-token')].some(token=>token.textContent==='viewport1999')",
      2000,
    );
    assert(
      await browser.evaluate<number>(
        "document.querySelectorAll('.otk-code-group').length",
      ) < 63,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-code code').textContent",
      ),
      source,
    );
    await browser.evaluate("releaseAllSourceTurns()");
    await browser.poll(
      "[...document.querySelectorAll('.otk-token')].some(token=>token.textContent==='viewport1999') && !!document.querySelector('.otk-code-plain')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-code code').textContent",
      ),
      source,
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('.otk-code-group')].every(group=>{const text=group.textContent;return (text.match(/\\r\\n|\\n|\\r/g)?.length||0)+(/[\\r\\n]$/.test(text)?0:1)<=32})",
      ),
      true,
      "Demanded source publications exceeded32 rows",
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('.otk-code-plain')].some(raw=>raw.textContent.includes('viewport700')&&!raw.querySelector('.otk-token'))",
      ),
      true,
      "Unvisited cold source was eagerly projected",
    );
  } finally {
    await f.stop();
  }
});

test("completed worker batches preserve multiline grammar and recalled unfinished source and colours", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Batch grammar and recall" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    const rows = Array.from({ length: 70 }, (_, i) => {
      if (i === 30) return "/* opened batch comment";
      if (i === 31 || i === 32) return `comment across batch ${i}`;
      if (i > 32 && i < 64) return `comment line ${i}`;
      if (i === 64) return "*/";
      return `const batch${i}: number = ${i};`;
    });
    const first = rows.join("\n") + "\nconst recalled";
    const final = first + "Name: number = 9;\nconst afterRecall: number = 1;";
    f.fake.queue({
      chunks: [
        "```ts\n" + first,
        "Name: number = 9;\nconst afterRecall: number = 1;\n```\n",
      ],
      delay: 1200,
    });
    await browser.type(
      "textarea[name=prompt]",
      "Cross completed batches and recall the tail",
    );
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('.otk-code code')?.textContent===${
        JSON.stringify(first)
      } && [...document.querySelectorAll('.otk-token')].some(el=>el.textContent==='recalled')`,
    );
    const before = await browser.evaluate<string>(
      "getComputedStyle([...document.querySelectorAll('.otk-token')].find(el=>el.textContent==='recalled')).color",
    );
    await scrollBoundary(browser);
    const commentColor = await browser.evaluate(
      "(()=>{const sample=document.createElement('span');sample.style.color='var(--otk-code-comment)';document.body.append(sample);const color=getComputedStyle(sample).color;sample.remove();return color})()",
    );
    for (const index of [31, 32]) {
      await browser.poll(
        `[...document.querySelectorAll('.otk-token')].some(el=>el.textContent.includes('comment across batch ${index}'))`,
      );
      assertEquals(
        await browser.evaluate(
          `getComputedStyle([...document.querySelectorAll('.otk-token')].find(el=>el.textContent.includes('comment across batch ${index}'))).color`,
        ),
        commentColor,
      );
      assert(
        await browser.evaluate(
          `[...document.querySelectorAll('.otk-token')].find(el=>el.textContent.includes('comment across batch ${index}')).getAttribute('style').includes('--otk-syntax-token-comment')`,
        ),
      );
    }
    await scroll(browser, true);
    await browser.poll(
      `document.querySelector('.otk-code code')?.textContent===${
        JSON.stringify(final)
      } && [...document.querySelectorAll('.otk-token')].some(el=>el.textContent==='recalledName')`,
    );
    assertEquals(
      await browser.evaluate(
        "getComputedStyle([...document.querySelectorAll('.otk-token')].find(el=>el.textContent==='recalledName')).color",
      ),
      before,
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('.otk-token')].some(el=>el.textContent==='recalled')",
      ),
      false,
    );
    assertEquals(
      await browser.evaluate(
        "getComputedStyle([...document.querySelectorAll('.otk-token')].find(el=>el.textContent==='afterRecall')).color",
      ),
      before,
    );
  } finally {
    await f.stop();
  }
});

test("real downward wheel retains follow intent when transcript growth precedes its scroll notification", async () => {
  const f = await browserFixture();
  try {
    const server = await f.sidecar(), browser = await f.browser(server.url);
    for (const numbered of [false, true]) {
      const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Wheel/layout ordering " + numbered },
      });
      if (numbered) {
        f.fake.queue({
          tool: {
            name: "write",
            input: {
              filePath: join(f.oc.directory, "wheel.ts"),
              content: source,
            },
          },
        }, { chunks: ["Written."] });
      } else f.fake.queue({ chunks: ["```ts\n" + source + "\n```\n"] });
      await f.oc.request(`/session/${session.id}/prompt_async`, {
        method: "POST",
        body: { parts: [{ type: "text", text: "Prepare wheel source" }] },
      });
      await waitFor(
        () =>
          f.oc.request<{ info: { time: { completed?: number } } }[]>(
            `/session/${session.id}/message`,
          ),
        (messages) => messages.some((message) => !!message.info.time.completed),
      );
      await openSession(browser, session.id);
      if (numbered) await showFileChanges(browser);
      await browser.poll(
        `document.querySelector('.otk-code code')?.textContent===${
          JSON.stringify(source)
        } && document.querySelector('.otk-project-sessions [aria-current=page]')?.dataset.status==='idle' && [...document.querySelectorAll('.otk-message-details')].every(el=>!el.textContent.includes('streaming')) && ${
          numbered
            ? "[...document.querySelectorAll('.otk-text p')].some(el=>el.textContent==='Written.')"
            : "true"
        } && (()=>{const p=document.querySelector('.otk-messages');return p.scrollHeight-p.clientHeight-p.scrollTop<2})()`,
      );
      const point = await browser.evaluate<{ x: number; y: number }>(
        `(async()=>{
          const pane=document.querySelector('.otk-messages');
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          await new Promise(resolve=>{pane.addEventListener('scrollend',resolve,{once:true});pane.scrollTop=pane.scrollHeight-pane.clientHeight-8});
          if(Math.abs(pane.scrollHeight-pane.clientHeight-pane.scrollTop-8)>.5)throw new Error('Wheel setup did not retain its reader position');
          globalThis.wheelLayoutEvidence=null;
          let armed=false;
          pane.addEventListener('wheel',()=>armed=true,{once:true,passive:true});
          const grow=()=>{
            if(!armed)return;
            pane.removeEventListener('scroll',grow,true);
            const before={top:pane.scrollTop,height:pane.scrollHeight,gap:pane.scrollHeight-pane.clientHeight-pane.scrollTop};
            const growth=document.createElement('div');growth.style.height='80px';growth.textContent='Late transcript layout';
            pane.querySelector('.otk-message-flow').append(growth);
            wheelLayoutEvidence={before,after:pane.scrollHeight};
          };
          pane.addEventListener('scroll',grow,true);
          const rect=pane.getBoundingClientRect();return {x:rect.left+8,y:rect.top+rect.height/2};
        })()`,
      );
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...point,
        deltaX: 0,
        deltaY: 100000,
      });
      await browser.poll("!!globalThis.wheelLayoutEvidence");
      const ordering = await browser.evaluate<
        { before: { gap: number; height: number }; after: number }
      >("wheelLayoutEvidence");
      assert(ordering.before.gap < 2, JSON.stringify(ordering));
      assert(ordering.after - ordering.before.height >= 80);
      await browser.poll(
        "(()=>{const p=document.querySelector('.otk-messages');return p.scrollHeight-p.clientHeight-p.scrollTop<2})()",
        3000,
      );
      assertEquals(
        await browser.evaluate(
          "document.querySelector('.otk-code code').textContent",
        ),
        source,
      );
      await browser.evaluate(
        `(()=>{const pane=document.querySelector('.otk-messages');pane.tabIndex=0;pane.focus();
          pane.addEventListener('keydown',()=>{
            globalThis.keyScrollEnded=false;
            const scroll=()=>keyScrollEnded=false,end=()=>keyScrollEnded=true;
            pane.addEventListener('scroll',scroll);pane.addEventListener('scrollend',end);
            globalThis.releaseKeyScroll=()=>{pane.removeEventListener('scroll',scroll);pane.removeEventListener('scrollend',end)};
          },{once:true});})()`,
      );
      // Space's native page-scroll default needs its character event as well
      // as keydown; observe actual scrollend rather than an animation frame.
      for (const type of ["keyDown", "keyUp"]) {
        await browser.send("Input.dispatchKeyEvent", {
          type,
          key: " ",
          code: "Space",
          modifiers: 8,
          windowsVirtualKeyCode: 32,
          nativeVirtualKeyCode: 32,
          ...(type === "keyDown" ? { text: " ", unmodifiedText: " " } : {}),
        });
      }
      await browser.poll(
        "globalThis.keyScrollEnded && (()=>{const p=document.querySelector('.otk-messages');return p.scrollHeight-p.clientHeight-p.scrollTop>100})()",
        3000,
      );
      await browser.evaluate("releaseKeyScroll()");
      const reader = await browser.evaluate<{ before: number; after: number }>(
        `(async()=>{const p=document.querySelector('.otk-messages'),before=p.scrollTop;
          const flow=p.querySelector('.otk-message-flow'),growth=document.createElement('div');growth.style.height='80px';
          await new Promise(resolve=>{const observer=new ResizeObserver(()=>{observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(resolve))});observer.observe(flow);flow.append(growth)});
          return {before,after:p.scrollTop};})()`,
      );
      assert(
        Math.abs(reader.before - reader.after) < 2,
        JSON.stringify(reader),
      );
    }
  } finally {
    await f.stop();
  }
});

async function scroll(browser: Cdp, bottom: boolean) {
  const point = await browser.evaluate<
    { x: number; y: number; distance: number }
  >(
    "(()=>{const pane=document.querySelector('.otk-messages'),r=pane.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,distance:pane.scrollHeight}})()",
  );
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY: bottom ? point.distance : -point.distance,
  });
  await browser.poll(
    bottom
      ? "(()=>{const p=document.querySelector('.otk-messages');return p.scrollHeight-p.clientHeight-p.scrollTop<2})()"
      : "document.querySelector('.otk-messages').scrollTop<2",
  );
}

/** A scroll-to-top is not a reveal: chrome height and preceding message content
 * can leave the first source line below the transcript's clip. Resolve a native
 * source point only after a real wheel brings it inside the consumer viewport. */
async function sourcePoint(browser: Cdp, expression: string) {
  const measure =
    `(()=>{const point=(${expression}),r=document.querySelector('.otk-messages').getBoundingClientRect();return {...point,visible:point.y>r.top&&point.y<r.bottom,pane:{x:r.x+r.width/2,y:r.y+r.height/2}}})()`;
  const point = await browser.evaluate<
    { x: number; y: number; visible: boolean; pane: { x: number; y: number } }
  >(measure);
  if (!point.visible) {
    console.info("Source target reveal", point);
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point.pane,
      deltaX: 0,
      deltaY: point.y - point.pane.y,
    });
    await browser.poll(`(${measure}).visible`);
  }
  return await browser.evaluate<{ x: number; y: number }>(
    `(()=>{const {x,y}=${measure};return {x,y}})()`,
  );
}

async function revealLine(browser: Cdp, selector: string, index: number) {
  await sourcePoint(
    browser,
    `(()=>{const code=document.querySelector(${
      JSON.stringify(selector)
    }),r=code.getBoundingClientRect(),line=(${sourceGeometry})(code,${index});return {x:r.x+Math.min(100,r.width/2),y:line.row}})()`,
  );
}

async function scrollBoundary(browser: Cdp) {
  const point = await browser.evaluate<{ x: number; y: number; delta: number }>(
    `(()=>{
    const pane=document.querySelector('.otk-messages'),r=pane.getBoundingClientRect(),code=document.querySelector('.otk-code code'),probe=${sourceGeometry},a=probe(code,31),b=probe(code,32);
    return {x:r.x+r.width/2,y:r.y+r.height/2,delta:(a.top+b.bottom)/2-(r.top+r.bottom)/2};
  })()`,
  );
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY: point.delta,
  });
  await browser.poll(
    `(()=>{const p=document.querySelector('.otk-messages').getBoundingClientRect(),code=document.querySelector('.otk-code code'),probe=${sourceGeometry};return [31,32].every(i=>{const r=probe(code,i);return r.top>=p.top&&r.bottom<=p.bottom})})()`,
  );
}

test("native raw source at a nested pane's leading clip requests its genuine colour", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Leading clipped source" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await showFileChanges(browser);
    f.fake.queue({
      tool: {
        name: "write",
        input: {
          filePath: join(f.oc.directory, "leading.ts"),
          content: source,
        },
      },
    }, { chunks: ["Written."] });
    await browser.type("textarea[name=prompt]", "Write leading clipped source");
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]')?.dataset.status==='idle' && [...document.querySelectorAll('.otk-token')].some(token=>token.textContent==='viewport1999')`,
    );
    const point = await browser.evaluate<
      { x: number; y: number; delta: number }
    >(`(()=>{const pane=document.querySelector('.otk-messages'),box=pane.getBoundingClientRect(),code=document.querySelector('.otk-code code'),row=(${sourceGeometry})(code,1983);return {x:box.x+box.width/2,y:box.y+box.height/2,delta:row.top-box.top-pane.clientTop}})()`);
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: point.delta,
    });
    await browser.poll(
      `(()=>{const pane=document.querySelector('.otk-messages').getBoundingClientRect(),code=document.querySelector('.otk-code code'),row=(${sourceGeometry})(code,1983);return row.top>=pane.top-.5&&row.bottom<=pane.bottom+.5})()`,
    );
    await browser.poll(
      "[...document.querySelectorAll('.otk-token')].some(token=>token.textContent==='viewport1983')",
      3000,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-code code').textContent",
      ),
      source,
    );
    const alignment = await browser.evaluate<number>(
      `(()=>{const block=document.querySelector('.otk-code'),row=(${sourceGeometry})(block.querySelector('code'),1983),numbers=block.querySelector('.otk-code-numbers').firstChild,text=numbers.textContent,offset=text.split('\\n').slice(0,1983).reduce((n,line)=>n+line.length+1,0),range=document.createRange();range.setStart(numbers,offset);range.setEnd(numbers,offset+4);const box=range.getBoundingClientRect();return Math.abs(row.glyph-(box.y+box.height/2))})()`,
    );
    assert(alignment <= .5, `Leading glyph/gutter misaligned:${alignment}`);
  } finally {
    await f.stop();
  }
});

test("source rows and selected raw endpoints survive token catch-up while another viewport warms", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Selected raw source" },
    });
    f.fake.queue({ chunks: ["```ts\n" + source + "\n```\n"] });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Prepare source" }] },
    });
    await waitFor(
      () =>
        f.oc.request<
          { info: { role: string; time: { completed?: number } } }[]
        >(`/session/${session.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.info.role === "assistant" && !!row.info.time.completed
        ),
    );
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    // Hold a genuine first worker reply so raw selection during catch-up is
    // deterministic; no product seam, synthetic tokens or timing assumption.
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(()=>{
      globalThis.heldHighlight=[];globalThis.holdHighlight=true;
      globalThis.sourceFocusEvidence=[];
      const Native=Worker;globalThis.Worker=class extends Native {
        constructor(...args){super(...args);this.addEventListener('message',event=>{if(holdHighlight){event.stopImmediatePropagation();heldHighlight.push({worker:this,data:event.data})}},true)}
        postMessage(value,...args){for(const request of Array.isArray(value)?value:[value]){const ranges=request.type==='focus'?request.ranges:request.focus;if(ranges?.length)sourceFocusEvidence.push({groups:document.querySelectorAll('.otk-code-group').length,tail:!!document.querySelector('.otk-code-plain'),ranges})}return super.postMessage(value,...args)}
      };
      globalThis.releaseHighlight=()=>{holdHighlight=false;for(const item of heldHighlight.splice(0))item.worker.dispatchEvent(new MessageEvent('message',{data:item.data}))};
    })()`,
    });
    await browser.goto(server.url);
    await openSession(browser, session.id);
    await browser.poll(
      "document.querySelector('.otk-code code')?.textContent.split(/\\r\\n|\\n|\\r/).length===2000 && heldHighlight.length>0",
    );
    assertEquals(
      await browser.evaluate(
        "sourceFocusEvidence.some(entry=>entry.tail && entry.groups<63 && entry.ranges.length>0)",
      ),
      true,
      "Viewport demand waited for every raw group despite complete native source",
    );
    await scroll(browser, false);
    const point = await sourcePoint(
      browser,
      `(()=>{
      const walker=document.createTreeWalker(document.querySelector('.otk-code code'),NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const start=node.textContent.indexOf('viewport0');if(start>=0){const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+9);const r=range.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}}throw new Error('No raw viewport0 node');
    })()`,
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await browser.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 2,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await browser.poll("getSelection().toString()==='viewport0'");
    await browser.evaluate(
      "globalThis.rawEndpoint=getSelection().anchorNode; releaseHighlight()",
    );
    await scroll(browser, true);
    await browser.poll(
      "[...document.querySelectorAll('.otk-code-group:last-child .otk-token')].some(el=>el.textContent==='viewport1999')",
    );
    assertEquals(
      await browser.evaluate(
        "getSelection().anchorNode===rawEndpoint && rawEndpoint.isConnected",
      ),
      true,
    );
    assertEquals(
      await browser.evaluate("getSelection().toString()"),
      "viewport0",
    );
    assertEquals(
      await browser.evaluate(
        "!!document.querySelector('.otk-code-group:first-child .otk-token')",
      ),
      false,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-code code').textContent",
      ),
      source,
    );
    await browser.send("Browser.grantPermissions", {
      origin: server.url,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await browser.key("c", 2);
    await browser.poll(
      "navigator.clipboard.readText().then(text=>text==='viewport0')",
    );
    await browser.click(".otk-tabs-project");
    await scroll(browser, false);
    await browser.poll(
      "[...document.querySelectorAll('.otk-code-group:first-child .otk-token')].some(el=>el.textContent==='viewport0')",
    );
  } finally {
    await f.stop();
  }
});

test("code viewport projection preserves complete text, selection/copy, real scroll colours and numbered write geometry", async () => {
  const f = await browserFixture();
  try {
    const markdown = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Viewport markdown" },
    });
    const write = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Viewport write" },
    });
    f.fake.queue({ chunks: ["```ts\n" + source + "\n```\n"] });
    await f.oc.request(`/session/${markdown.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Viewport source" }] },
    });
    await waitFor(
      () =>
        f.oc.request<
          { info: { role: string; time: { completed?: number } } }[]
        >(`/session/${markdown.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.info.role === "assistant" && !!row.info.time.completed
        ),
    );
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, markdown.id);
    await showFileChanges(browser);
    await browser.poll(
      `document.querySelector('.otk-code code')?.textContent===${
        JSON.stringify(source)
      }`,
    );
    await browser.poll(
      "document.querySelector('.otk-code code')?.textContent.split(/\\r\\n|\\n|\\r/).length===2000 && !!document.querySelector('.otk-code-plain')",
      60000,
    );
    await scroll(browser, false);
    await browser.poll(
      "[...document.querySelectorAll('.otk-code-group:first-child .otk-token')].some(el=>el.textContent==='viewport0')",
    );
    assertEquals(
      await browser.evaluate(
        "!!document.querySelector('.otk-code-group:last-child .otk-token')",
      ),
      false,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-code code').textContent",
      ),
      source,
    );
    const prefix = await browser.evaluate(
      "[...document.querySelectorAll('.otk-code-group:first-child .otk-token')].slice(0,8).map(el=>({text:el.textContent,color:getComputedStyle(el).color}))",
    );
    const point = await sourcePoint(
      browser,
      "(()=>{const token=[...document.querySelectorAll('.otk-code-group:first-child .otk-token')].find(el=>el.textContent==='viewport0'),r=token.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await browser.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 2,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await browser.poll("getSelection().toString()==='viewport0'");
    await scroll(browser, true);
    await browser.poll(
      "[...document.querySelectorAll('.otk-code-group:last-child .otk-token')].some(el=>el.textContent==='viewport1999')",
    );
    assertEquals(
      await browser.evaluate("getSelection().toString()"),
      "viewport0",
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('.otk-code-group:first-child .otk-token')].slice(0,8).map(el=>({text:el.textContent,color:getComputedStyle(el).color}))",
      ),
      prefix,
    );
    await browser.send("Browser.grantPermissions", {
      origin: server.url,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await browser.key("c", 2);
    await browser.poll(
      "navigator.clipboard.readText().then(text=>text==='viewport0')",
    );
    await browser.click(".otk-tabs-project");
    await browser.poll(
      "!document.querySelector('.otk-code-group:first-child .otk-token')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-code code').textContent",
      ),
      source,
    );
    const nativeText = await browser.evaluate<string>(
      "document.body.innerText",
    );
    assert(
      nativeText.includes("const viewport0: number = 0;") &&
        nativeText.includes("const viewport1999: number = 1999;"),
    );
    assertEquals(
      await browser.evaluate(
        "(()=>{const code=document.querySelector('.otk-code code'),walk=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);let node;while(node=walk.nextNode()){if(node.textContent.includes('viewport700'))return !node.parentElement.closest('.otk-code-plain,.otk-code-raw')||!!node.parentElement.closest('.otk-token')}throw new Error('Missing cold native source')})()",
      ),
      false,
    );
    await browser.screenshot(join(f.oc.root, "code-viewport-markdown.png"));

    f.fake.queue({
      tool: {
        name: "write",
        input: {
          filePath: join(f.oc.directory, "viewport.ts"),
          content: source,
        },
      },
    }, { chunks: ["Written source."] });
    await f.oc.request(`/session/${write.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Write viewport source" }] },
    });
    await waitFor(
      () =>
        f.oc.request<
          { info: { role: string; time: { completed?: number } } }[]
        >(`/session/${write.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.info.role === "assistant" && !!row.info.time.completed
        ),
    );
    await openSession(browser, write.id);
    await browser.poll(
      `document.querySelector('.otk-code[data-numbered=true] code')?.textContent===${
        JSON.stringify(source)
      }`,
    );
    await browser.poll(
      "document.querySelector('.otk-code code')?.textContent.split(/\\r\\n|\\n|\\r/).length===2000 && !!document.querySelector('.otk-code-plain')",
      60000,
    );
    await scroll(browser, true);
    await revealLine(browser, ".otk-code[data-numbered=true] code", 1999);
    await browser.poll(
      "[...document.querySelectorAll('.otk-code .otk-token')].some(el=>el.textContent==='viewport1999')",
    );
    const geometry = await browser.evaluate<
      {
        index: number;
        row: number;
        number: number;
        glyph?: number;
        height: number;
        lineHeight: number;
      }[]
    >(`(()=>{
      const code=document.querySelector('.otk-code'),probe=${sourceGeometry},walker=document.createTreeWalker(code.querySelector('.otk-code-numbers'),NodeFilter.SHOW_TEXT),numbers=walker.nextNode();
      return [0,126,1999].map(index=>{const row=probe(code.querySelector('code'),index),text=numbers.textContent,offset=text.split('\\n').slice(0,index).reduce((n,line)=>n+line.length+1,0),range=document.createRange();range.setStart(numbers,offset);range.setEnd(numbers,offset+String(index+1).length);const g=range.getBoundingClientRect();return {...row,number:g.y+g.height/2}});
    })()`);
    for (const row of geometry) {
      assert(
        row.glyph !== undefined
          ? Math.abs(row.glyph - row.number) <= .5
          : Math.abs(
                (row.row - geometry[0].row) - (row.number - geometry[0].number),
              ) <= .5 && Math.abs(row.height - row.lineHeight) <= .5,
        `Code/gutter row ${row.index}: ${JSON.stringify(row)}`,
      );
    }
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-code code').textContent",
      ),
      source,
    );
    await browser.screenshot(join(f.oc.root, "code-viewport-write.png"));
  } finally {
    await f.stop();
  }
});

test("source commits stay atomic and selected raw/styled endpoints survive genuine appended bytes", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Atomic source append" },
    });
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(()=>{
      globalThis.atomicFailures=[];globalThis.expectedCode='';globalThis.expectedMarker='';
      new MutationObserver(()=>{const code=[...document.querySelectorAll('.otk-code code')].at(-1);if(code&&[...document.querySelectorAll('.otk-text p')].some(p=>p.textContent===expectedMarker)&&code.textContent!==expectedCode)atomicFailures.push({code:code.textContent,expected:expectedCode})}).observe(document,{subtree:true,childList:true,characterData:true});
      globalThis.holdTokens=false;globalThis.heldTokens=[];
      const Native=Worker;globalThis.Worker=class extends Native{constructor(...args){super(...args);this.addEventListener('message',event=>{if(holdTokens&&event.data.tokens){event.stopImmediatePropagation();heldTokens.push({worker:this,data:event.data})}},true)}};
      globalThis.releaseTokens=()=>{holdTokens=false;for(const item of heldTokens.splice(0))item.worker.dispatchEvent(new MessageEvent('message',{data:item.data}))};
    })()`,
    });
    await browser.goto(server.url);
    await openSession(browser, session.id);
    for (const mode of ["atomic", "raw", "styled"]) {
      const word = mode + "Word",
        first = "const " + word,
        final = first + "Name: number = 9;",
        marker = mode + " source committed.";
      await browser.evaluate(
        `expectedCode=${JSON.stringify(final)};expectedMarker=${
          JSON.stringify(marker)
        };holdTokens=${mode === "raw"};atomicFailures=[]`,
      );
      f.fake.queue({
        chunks: ["```ts\n" + first, "Name: number = 9;\n```\n" + marker],
        delay: 1400,
      });
      await browser.type("textarea[name=prompt]", "Append " + mode + " source");
      await browser.key("Enter");
      await browser.poll(
        `[...document.querySelectorAll('.otk-code code')].at(-1)?.textContent===${
          JSON.stringify(first)
        } && ${
          mode === "raw"
            ? "heldTokens.length>0"
            : `[...document.querySelectorAll('.otk-token')].some(el=>el.textContent===${
              JSON.stringify(word)
            })`
        }`,
      );
      if (mode !== "atomic") {
        const point = await browser.evaluate<{ x: number; y: number }>(`(()=>{
          const code=[...document.querySelectorAll('.otk-code code')].at(-1),walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const start=node.textContent.indexOf(${
          JSON.stringify(word)
        });if(start>=0){const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+${word.length});const r=range.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}}throw new Error('No word node');
        })()`);
        for (const type of ["mousePressed", "mouseReleased"]) {
          await browser.send("Input.dispatchMouseEvent", {
            type,
            ...point,
            button: "left",
            clickCount: 2,
            buttons: type === "mousePressed" ? 1 : 0,
          });
        }
        await browser.poll(
          `getSelection().toString()===${JSON.stringify(word)}`,
        );
        await browser.evaluate(
          "globalThis.appendEndpoint=getSelection().anchorNode;globalThis.appendCode=[...document.querySelectorAll('.otk-code code')].at(-1);globalThis.appendMessage=appendCode.closest('.otk-message')",
        );
      }
      await browser.poll(
        `[...document.querySelectorAll('.otk-text p')].some(p=>p.textContent===${
          JSON.stringify(marker)
        }) && document.querySelector('.otk-project-sessions [aria-current=page]')?.dataset.status==='idle'`,
      );
      assertEquals(
        await browser.evaluate(
          "[...document.querySelectorAll('.otk-code code')].at(-1).textContent",
        ),
        final,
      );
      assertEquals(
        await browser.evaluate("atomicFailures"),
        [],
        `Missing source during ${mode} commit`,
      );
      if (mode !== "atomic") {
        assertEquals(
          await browser.evaluate(
            "getSelection().anchorNode===appendEndpoint && appendEndpoint.isConnected",
          ),
          true,
          await browser.evaluate(
            `JSON.stringify({mode:${
              JSON.stringify(mode)
            },messageConnected:appendMessage.isConnected,codeConnected:appendCode.isConnected,endpointConnected:appendEndpoint.isConnected})`,
          ),
        );
        assertEquals(await browser.evaluate("getSelection().toString()"), word);
        await browser.send("Browser.grantPermissions", {
          origin: server.url,
          permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        });
        await browser.key("c", 2);
        await browser.poll(
          `navigator.clipboard.readText().then(text=>text===${
            JSON.stringify(word)
          })`,
        );
      }
      if (mode === "raw") await browser.evaluate("releaseTokens()");
      await browser.click(".otk-tabs-project");
      await browser.poll(
        `[...document.querySelectorAll('.otk-token')].some(el=>el.textContent===${
          JSON.stringify(word + "Name")
        })`,
      );
    }
  } finally {
    await f.stop();
  }
});

test("numbered source retains natural empty, blank and terminal geometry through raw grouping and styling", async () => {
  const f = await browserFixture();
  try {
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: String.raw`(()=>{
      const nativeRow=${sourceGeometry};
      globalThis.shapeSamples=[];globalThis.heldShape=[];globalThis.holdShape=true;globalThis.shapeExpected='';globalThis.shapeTargets=[];
      const Native=Worker;globalThis.Worker=class extends Native{constructor(...args){super(...args);this.addEventListener('message',event=>{if(holdShape&&event.data.tokens){event.stopImmediatePropagation();heldShape.push({worker:this,data:event.data})}},true)}};
      globalThis.releaseShape=()=>{holdShape=false;for(const item of heldShape.splice(0))item.worker.dispatchEvent(new MessageEvent('message',{data:item.data}))};
      globalThis.measureShape=()=>{
        const block=document.querySelector('.otk-code[data-numbered=true]');if(!block)return;
        const code=block.querySelector('code'),rows=[...code.querySelectorAll('.otk-code-line')],numbers=block.querySelector('.otk-code-numbers'),walker=document.createTreeWalker(numbers,NodeFilter.SHOW_TEXT);const numberNode=walker.nextNode();
        // Pending write metadata may temporarily expose its own empty source.
        // Measure only the accepted input's gutter/source coordinate frame.
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
    })()`,
    });
    await browser.goto(server.url);
    await browser.poll("document.fonts.status==='loaded'");
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
      const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Natural shape " + index },
      });
      await openSession(browser, session.id);
      if (index === 0) {
        await showFileChanges(browser);
      }
      await browser.evaluate(
        `shapeSamples=[];heldShape=[];holdShape=true;shapeExpected=${
          JSON.stringify(content)
        };shapeTargets=${JSON.stringify(targets)}`,
      );
      f.fake.queue({
        tool: {
          name: "write",
          input: {
            filePath: join(f.oc.directory, "shape-" + index + ".ts"),
            content,
          },
        },
      }, { chunks: ["Written."] });
      await browser.type("textarea[name=prompt]", "Write shape " + index);
      await browser.key("Enter");
      await browser.poll(
        `document.querySelector('.otk-code[data-numbered=true] code')?.textContent===${
          JSON.stringify(content)
        } && document.querySelectorAll('.otk-code-group').length>0 && heldShape.length>0`,
      );
      await browser.evaluate("measureShape();releaseShape()");
      if (targets.length) {
        await scroll(browser, true);
        await revealLine(
          browser,
          ".otk-code[data-numbered=true] code",
          targets.at(-1)!.index,
        );
        await browser.poll(
          `[...document.querySelectorAll('.otk-token')].some(el=>el.textContent===${
            JSON.stringify(targets.at(-1)!.word)
          })`,
        );
      }
      await browser.evaluate("measureShape()");
      const samples = await browser.evaluate<
        {
          exact: boolean;
          bounded: boolean;
          groups: number;
          tokens: number;
          centres: { code?: number; number: number }[];
          positions: { row: number; number: number; height: number }[];
          rowHeights: number[];
          lineHeight: number;
        }[]
      >("shapeSamples");
      assert(samples.length > 0);
      for (const sample of samples) {
        assertEquals(
          sample.bounded,
          true,
          "Source group exceeded32 logical rows",
        );
        assertEquals(
          sample.exact,
          true,
          "Raw/grouped/styled source bytes changed",
        );
        for (const centre of sample.centres) {
          assert(
            centre.code !== undefined &&
              Math.abs(centre.code - centre.number) <= .5,
            JSON.stringify(centre),
          );
        }
        for (const height of sample.rowHeights) {
          assert(
            Math.abs(height - sample.lineHeight) <= .5,
            "Logical row height changed",
          );
        }
        assert(sample.positions.length > 0);
        for (const row of sample.positions) {
          assert(
            Math.abs(
                  (row.row - sample.positions[0].row) -
                    (row.number - sample.positions[0].number),
                ) <= .5 &&
              Math.abs(row.height - sample.lineHeight) <= .5,
            "Native blank/final row geometry changed: " + JSON.stringify(row),
          );
        }
      }
      if (index === 2) {
        assert(samples.some((sample) =>
          sample.groups === 1 && sample.tokens === 0
        ));
        assert(samples.some((sample) =>
          sample.groups > 1 && sample.tokens > 0
        ));
      }
      await browser.poll(
        `document.querySelector('[data-session="${session.id}"]')?.dataset.status==='idle' && [...document.querySelectorAll('.otk-text p')].some(paragraph=>paragraph.textContent==='Written.')`,
      );
    }
  } finally {
    await f.stop();
  }
});
