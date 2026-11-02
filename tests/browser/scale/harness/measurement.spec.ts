// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { assertContentReleased, sessionHeap } from "../../../support/heap.ts";
import {
  assertHighlightBudget,
  type HighlightEvidence,
  highlightObservers,
} from "../../../support/highlight-latency.ts";
import { heapPort } from "../../fixtures/heap.ts";

test(
  "harness.highlight-starvation",
  { tag: ["@harness", "@scale"] },
  async ({ page }, info) => {
    await page.setContent(
      '<div class="otk-messages" style="height:600px"><code></code></div>',
    );
    await page.evaluate(
      `globalThis.append=(i)=>{const code=document.querySelector('code');const span=document.createElement('span');span.textContent='probe'+i+' ';code.append(span);clearTimeout(globalThis.paint);globalThis.paint=setTimeout(()=>{for(const el of code.children){el.className='otk-token';el.style.color='rgb(1, 2, 3)'}},150)}`,
    );
    await page.evaluate(highlightObservers);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(`highlightMeasure('code','probe${i}');append(${i})`);
      await expect.poll(() => page.evaluate("highlightEvidence.blocks.length"))
        .toBe(i + 1);
    }
    assertHighlightBudget(await page.evaluate("highlightEvidence.blocks"), 4);
    await page.evaluate(
      `document.querySelector('code').replaceChildren();highlightStream('code','probe');globalThis.producer=new Promise(resolve=>{let i=0;const tick=()=>{append(i++);if(i<24)setTimeout(tick,100);else resolve()};tick()})`,
    );
    await page.evaluate("producer");
    await expect.poll(() =>
      page.evaluate(
        "highlightEvidence.revisions.length===24 && highlightEvidence.revisions.every(sample=>sample.end!==undefined)",
      )
    ).toBe(true);
    await page.evaluate("highlightCancel()");
    const evidence = await page.evaluate<HighlightEvidence>(
      "highlightEvidence",
    );
    expect(evidence.revisions.map((sample) => sample.marker)).toEqual(
      Array.from({ length: 24 }, (_, i) => `probe${i}`),
    );
    expect(assertHighlightBudget(evidence.revisions, 24).p95).toBeGreaterThan(
      200,
    );
    expect(() => assertHighlightBudget(evidence.revisions.slice(1), 24))
      .toThrow();
    expect(() =>
      assertHighlightBudget([{ ...evidence.revisions[0], end: undefined }], 1)
    ).toThrow();
    await info.attach("highlight-samples", {
      body: JSON.stringify(evidence),
      contentType: "application/json",
    });
    await page.evaluate("highlightStop()");
  },
);

test(
  "harness.heap-identities",
  { tag: ["@harness", "@scale"] },
  async ({ page, context }, info) => {
    const port = await heapPort(context, page);
    try {
      await page.evaluate(
        `globalThis.held={sessionID:'heap-probe',parts:[{text:String.fromCharCode(79,84,75,95,72,69,65,80,95,80,82,79,66,69,95)+'payload'}]};globalThis.noise=Array.from({length:400000},(_,i)=>({i}));void 0`,
      );
      const retained = await sessionHeap(port, "heap-probe", "OTK_HEAP_PROBE_");
      expect(retained.length).toBeGreaterThanOrEqual(2);
      expect(() => assertContentReleased(retained)).toThrow();
      await page.evaluate("delete globalThis.held;void 0");
      assertContentReleased(
        await sessionHeap(port, "heap-probe", "OTK_HEAP_PROBE_"),
      );
      expect(await page.evaluate("globalThis.noise.length")).toBe(400000);
      await info.attach("retained-paths", {
        body: JSON.stringify(retained),
        contentType: "application/json",
      });
    } finally {
      await port.close();
    }
  },
);

for (
  const owner of [
    "closure Map",
    "flat tail",
    "sliced backing",
    "split cons",
    "detached text",
    "empty transcript",
  ]
) {
  test(`harness.heap-${owner.replaceAll(" ", "-")}`, {
    tag: ["@harness", "@scale"],
  }, async ({ page, context }, info) => {
    const port = await heapPort(context, page);
    const marker = `OTK_STRING_ONLY_${owner.replaceAll(" ", "_")}_`;
    try {
      await page.evaluate(`(()=>{
        const marker=String.fromCharCode(${
        [...marker].map((c) => c.charCodeAt(0))
      });
        const owner=${JSON.stringify(owner)};
        let payload='prefix '+marker+'x'.repeat(2*1024*1024);
        if(owner==='flat tail')payload=('x'.repeat(2*1024*1024)+marker).split('').join('');
        if(owner==='sliced backing')payload=payload.slice(128);
        if(owner==='split cons'){
          const first=String.fromCharCode(${
        [...marker.slice(0, Math.floor(marker.length / 2))].map((c) =>
          c.charCodeAt(0)
        )
      });
          const second=String.fromCharCode(${
        [...marker.slice(Math.floor(marker.length / 2))].map((c) =>
          c.charCodeAt(0)
        )
      });
          payload=first+second+'x'.repeat(2*1024*1024);
        }
        if(!['detached text','empty transcript'].includes(owner)){
          const cache=new Map([[1,payload]]);globalThis.retentionProbe=()=>cache.get(1).length;
        }else{
          const transcript=document.createElement('div');transcript.className='otk-messages';
          if(owner==='detached text')transcript.append(document.createTextNode(payload));
          document.body.append(transcript);globalThis.retentionProbe=owner==='detached text'?transcript.firstChild:transcript;transcript.remove();
        }
      })();void 0`);
      expect(await page.locator(".otk-messages").count()).toBe(0);
      const retained = await sessionHeap(port, "string-only-session", marker);
      expect(() => assertContentReleased(retained)).toThrow();
      expect(retained.every((node) => node.path.length > 1)).toBe(true);
      expect(
        retained.some((node) =>
          node.kind ===
            (["detached text", "empty transcript"].includes(owner)
              ? "dom"
              : "string")
        ),
      ).toBe(true);
      if (owner === "split cons") {
        expect(retained.some((node) => node.type === "concatenated string"))
          .toBe(true);
      }
      await page.evaluate("delete globalThis.retentionProbe;void 0");
      assertContentReleased(
        await sessionHeap(port, "string-only-session", marker),
      );
      await info.attach("retained-paths", {
        body: JSON.stringify({ owner, retained }),
        contentType: "application/json",
      });
    } finally {
      await port.close();
    }
  });
}
