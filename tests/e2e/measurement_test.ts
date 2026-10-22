// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Cdp } from "../support/cdp.ts";
import { fixture } from "../support/config.ts";
import { assertContentReleased, sessionHeap } from "../support/heap.ts";
import { menuReady } from "../support/menu.ts";

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
