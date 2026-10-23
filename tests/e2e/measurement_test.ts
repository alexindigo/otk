// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Cdp } from "../support/cdp.ts";
import { fixture } from "../support/config.ts";
import { assertContentReleased, sessionHeap } from "../support/heap.ts";
import { menuReady } from "../support/menu.ts";
import {
  assertHighlightBudget,
  type HighlightEvidence,
  highlightObservers,
} from "../support/highlight-latency.ts";

test("highlight sampling rejects stream starvation hidden by acknowledged updates", async () => {
  const root = await fixture(), browser = await Cdp.launch(root);
  try {
    await browser.evaluate(
      `document.body.innerHTML='<div class="otk-messages"><code></code></div>';document.querySelector('.otk-messages').style.height='600px';globalThis.append=(i)=>{const code=document.querySelector('code');const span=document.createElement('span');span.textContent='probe'+i+' ';code.append(span);clearTimeout(globalThis.paint);globalThis.paint=setTimeout(()=>{for(const el of code.children){el.className='otk-token';el.style.color='rgb(1, 2, 3)'}},150)}`,
    );
    await browser.evaluate(highlightObservers);
    // The same renderer is quick enough when the producer is held for paint.
    for (let i = 0; i < 4; i++) {
      await browser.evaluate(
        `highlightMeasure('code','probe${i}');append(${i})`,
      );
      await browser.poll(`highlightEvidence.blocks.length===${i + 1}`);
    }
    assertHighlightBudget(
      await browser.evaluate<HighlightEvidence["blocks"]>(
        "highlightEvidence.blocks",
      ),
      4,
    );
    // The producer never reads observer state. Repeated input cancels pending
    // paint, so early source revisions wait for the end of the entire stream.
    await browser.evaluate(
      `document.querySelector('code').replaceChildren();highlightStream('code','probe');globalThis.producer=new Promise(resolve=>{let i=0;const tick=()=>{append(i++);if(i<24)setTimeout(tick,100);else resolve()};tick()})`,
    );
    await browser.evaluate("producer");
    await browser.poll(
      "highlightEvidence.revisions.length===24 && highlightEvidence.revisions.every(sample=>sample.end!==undefined)",
    );
    await browser.evaluate("highlightCancel()");
    const evidence = await browser.evaluate<HighlightEvidence>(
      "highlightEvidence",
    );
    assertEquals(
      evidence.revisions.map((sample) => sample.marker),
      Array.from({ length: 24 }, (_, i) => `probe${i}`),
    );
    assertThrows(
      () => assertHighlightBudget(evidence.revisions, 24),
      Error,
      "exceeds 200 ms",
    );
    // A missing or unpainted sample must also fail, not shrink the population.
    assertThrows(() => assertHighlightBudget(evidence.revisions.slice(1), 24));
    assertThrows(() =>
      assertHighlightBudget([{ ...evidence.revisions[0], end: undefined }], 1)
    );
    console.info("Highlight starvation control", {
      acknowledged: evidence.blocks.map((sample) => sample.latency),
      passive: evidence.revisions.map((sample) => sample.latency),
    });
    await browser.evaluate("highlightStop()");
  } finally {
    await browser.close();
  }
});

test("session heap distinguishes retained content identities from unrelated warmed allocations", async () => {
  const root = await fixture(), browser = await Cdp.launch(root);
  try {
    await browser.evaluate(
      `globalThis.held={sessionID:'heap-probe',parts:[{text:'OTK_HEAP_PROBE_payload'}]};globalThis.noise=Array.from({length:400000},(_,i)=>({i}));void 0`,
    );
    const retained = await sessionHeap(
      browser,
      "heap-probe",
      "OTK_HEAP_PROBE_",
    );
    assert(
      retained.length >= 2,
      "Must identify both message and content, not just string bytes",
    );
    assertThrows(() => assertContentReleased(retained));
    await browser.evaluate("delete globalThis.held;void 0");
    assertContentReleased(
      await sessionHeap(browser, "heap-probe", "OTK_HEAP_PROBE_"),
    );
    assertEquals(await browser.evaluate("globalThis.noise.length"), 400000);
  } finally {
    await browser.close();
  }
});

test("menu readiness joins native toggle, owned focus and rendered placement instead of DOM presence", async () => {
  const root = await fixture(), browser = await Cdp.launch(root);
  try {
    const premature = await browser.evaluate(`(()=>{
      document.body.innerHTML='<span class="otk-context-menu" data-open="false"><div id="panel" class="otk-popover-panel" popover><div class="otk-surface"><div role="menu"><button role="menuitem">Action</button></div></div></div></span>';
      const owner=document.querySelector('.otk-context-menu'),panel=document.querySelector('#panel');
      panel.addEventListener('toggle',()=>{owner.dataset.open=String(panel.matches(':popover-open'));if(panel.matches(':popover-open'))panel.querySelector('button').focus()});
      panel.showPopover();return {dom:!!document.querySelector(':popover-open [role=menu]'),owner:owner.dataset.open};
    })()`);
    assertEquals(premature, { dom: true, owner: "false" });
    await menuReady(browser, ":popover-open [role=menu]");
    assertEquals(
      await browser.evaluate("document.activeElement.textContent"),
      "Action",
    );
  } finally {
    await browser.close();
  }
});
