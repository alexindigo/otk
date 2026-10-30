// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Cdp } from "../support/cdp.ts";
import { tempDir, test } from "../support/resources.ts";

test("pointer readiness leaves a visible target's scroll authority alone and reveals a clipped nested target", async () => {
  const browser = await Cdp.launch(await tempDir("pc-"));
  await browser.evaluate(`(()=>{
    document.body.innerHTML='<button id="visible">Visible action</button><div id="pane" style="height:100px;overflow:auto;margin-top:20px"><div style="height:200px"></div><button id="clipped">Clipped action</button><div style="height:200px"></div></div>';
    globalThis.clicks=[];globalThis.scrollCalls=0;
    for(const button of document.querySelectorAll('button'))button.addEventListener('click',event=>clicks.push({id:button.id,trusted:event.isTrusted}));
    const scroll=Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView=function(options){scrollCalls++;return scroll.call(this,options)};
  })()`);
  await browser.click("#visible");
  assertEquals(await browser.evaluate("scrollCalls"), 0);
  assertEquals(await browser.evaluate("clicks"), [{
    id: "visible",
    trusted: true,
  }]);
  await browser.click("#clipped");
  assertEquals(await browser.evaluate("scrollCalls"), 1);
  assertEquals(await browser.evaluate("clicks"), [{
    id: "visible",
    trusted: true,
  }, { id: "clipped", trusted: true }]);
  assertEquals(
    await browser.evaluate("document.querySelector('#pane').scrollTop>0"),
    true,
  );
  assertEquals(browser.errors, []);
});

test("context pointer readiness reveals a clipped target before dispatching one trusted gesture", async () => {
  const browser = await Cdp.launch(await tempDir("pr-"));
  await browser.evaluate(`(()=>{
    document.body.innerHTML='<button id="visible">Visible action</button><div id="pane" style="height:100px;overflow:auto;margin-top:20px"><div style="height:200px"></div><button id="clipped">Clipped action</button><div style="height:200px"></div></div>';
    globalThis.contexts=[];globalThis.scrollCalls=0;
    document.addEventListener('contextmenu',event=>{event.preventDefault();contexts.push({id:event.target.id,trusted:event.isTrusted})});
    const scroll=Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView=function(options){scrollCalls++;return scroll.call(this,options)};
  })()`);
  await browser.rightClick("#visible");
  await browser.poll("contexts.length===1");
  assertEquals(await browser.evaluate("scrollCalls"), 0);
  await browser.rightClick("#clipped");
  await browser.poll("contexts.length===2");
  assertEquals(await browser.evaluate("contexts"), [
    { id: "visible", trusted: true },
    { id: "clipped", trusted: true },
  ]);
  assertEquals(await browser.evaluate("scrollCalls"), 1);
  assertEquals(browser.errors, []);
});
