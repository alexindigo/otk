// SPDX-License-Identifier: LGPL-3.0-only
import type { Cdp } from "./cdp.ts";

/** Wait for the consumer's measured window and its acquired range to settle. */
export async function settledTranscriptCount(browser: Cdp): Promise<number> {
  return await browser.poll(`(async()=>{
    const pane=document.querySelector('.otk-messages');
    const flow=pane?.querySelector('.otk-message-flow');
    if(!flow || Number(flow.dataset.messageCount)<20)return false;
    let previous='',stable=0;
    while(stable<5){
      await new Promise(requestAnimationFrame);
      const next=JSON.stringify([flow.dataset.messageCount,pane.scrollTop,pane.scrollHeight,pane.clientHeight]);
      stable=next===previous?stable+1:0;previous=next;
    }
    return Number(flow.dataset.messageCount);
  })()`) as number;
}

/** Locate acquired content through the real scroll surface, including rows
 * that are not mounted until the reader reaches their measured range. */
export async function revealViewportElement(
  browser: Cdp,
  viewport: string,
  selector: string,
): Promise<void> {
  // Resource publication precedes nested measured-window mounting. Do not
  // interpret the initial zero-height root as an exhausted acquired range.
  await browser.evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  const probe = () =>
    browser.evaluate<{
      top: number;
      height: number;
      end: number;
      delta?: number;
    }>(
      `(()=>{const p=document.querySelector(${
        JSON.stringify(viewport)
      }),e=p.querySelector(${
        JSON.stringify(selector)
      }),v=p.getBoundingClientRect(),r=e?.getBoundingClientRect();return{top:p.scrollTop,height:p.clientHeight,end:p.scrollHeight-p.clientHeight,delta:r?(r.top>=v.top&&r.bottom<=v.bottom?0:r.top+Math.min(r.height,p.clientHeight)/2-v.top-p.clientHeight/2):undefined}})()`,
    );
  let state = await probe();
  if (state.delta === undefined) {
    await wheelViewport(browser, viewport, -state.end);
    state = await probe();
  }
  while (state.delta === undefined) {
    if (state.top >= state.end) {
      throw new Error(`Acquired target is unavailable: ${selector}`);
    }
    await wheelViewport(browser, viewport, state.height);
    state = await probe();
  }
  await wheelViewport(browser, viewport, state.delta);
}

/** Drive a real scroll intent. An imperative scrollTop write is not a reveal
 * request and can race a deliberately pending geometry transaction. */
export async function wheelViewport(
  browser: Cdp,
  selector: string,
  deltaY: number,
): Promise<void> {
  if (Math.abs(deltaY) < 1) return;
  const point = await browser.evaluate<
    { x: number; y: number; canMove: boolean }
  >(`(async()=>{const e=document.querySelector(${
    JSON.stringify(selector)
  });let previous='',stable=0;while(stable<2){await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect(),next=JSON.stringify([e.scrollTop,e.scrollHeight,e.clientHeight,r.x,r.y,r.width,r.height]);stable=next===previous?stable+1:0;previous=next;}const r=e.getBoundingClientRect(),canMove=${deltaY}<0?e.scrollTop>0:e.scrollTop<e.scrollHeight-e.clientHeight;globalThis.messageWheelDone=!canMove;if(canMove)e.addEventListener('scrollend',()=>globalThis.messageWheelDone=true,{once:true});return{x:r.x+r.width/2,y:r.y+r.height/2,canMove}})()`);
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY,
  });
  if (point.canMove) await browser.poll("globalThis.messageWheelDone");
  await browser.evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
}
