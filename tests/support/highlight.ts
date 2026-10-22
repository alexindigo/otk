// SPDX-License-Identifier: LGPL-3.0-only
import type { Cdp } from "./cdp.ts";

/** Demand the marker's actual rendered range until that same range is styled.
 * A backend idle status and a one-shot scroll do not own viewport demand.
 */
export async function highlightedRange(
  browser: Cdp,
  selector: string,
  marker: string,
): Promise<void> {
  try {
    await browser.poll(`(async()=>{
    const code=document.querySelector(${JSON.stringify(selector)});
    if(!code) return false;
    const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
    let node,range;
    while(node=walker.nextNode()) {
      const start=node.textContent.indexOf(${JSON.stringify(marker)});
      if(start<0) continue;
      range=document.createRange();range.setStart(node,start);range.setEnd(node,start+${marker.length});break;
    }
    if(!range) return false;
    const viewport=code.closest('.otk-messages')?.getBoundingClientRect() ?? {top:0,bottom:innerHeight,left:0,right:innerWidth};
    let rect=range.getBoundingClientRect();
    if(rect.top<viewport.top || rect.bottom>viewport.bottom || rect.left<viewport.left || rect.right>viewport.right) {
      // Scroll the range, not the containing 2000-line block. The next read
      // re-resolves its nodes after any raw-to-token projection replacement.
      const scroller=code.closest('.otk-messages');
      if(scroller) scroller.scrollBy({top:rect.top-(viewport.top+viewport.bottom)/2,left:0,behavior:'instant'});
      else node.parentElement.scrollIntoView({block:'center',behavior:'instant'});
      return false;
    }
    for(let frame=0;frame<2;frame++) {
      await new Promise(requestAnimationFrame);
      const next=range.getBoundingClientRect();
      if(next.top!==rect.top || next.left!==rect.left || next.width!==rect.width || !node.isConnected) return false;
      rect=next;
    }
    const token=node.parentElement.closest('.otk-token');
    return !!token && code.contains(token) && !!token.style.color && getComputedStyle(token).color!=='rgba(0, 0, 0, 0)';
  })()`);
  } catch (cause) {
    const geometry = await browser.evaluate(
      `(()=>{const el=document.querySelector(${
        JSON.stringify(selector)
      });return {code:el?.getBoundingClientRect().toJSON(),text:el?.textContent.slice(-200),tokens:[...el?.querySelectorAll('.otk-token')??[]].slice(-10).map(token=>token.textContent),viewport:el?.closest('.otk-messages')?.getBoundingClientRect().toJSON()}})()`,
    );
    throw new Error(
      `Highlighted range ${marker} in ${selector}: ${JSON.stringify(geometry)}`,
      { cause },
    );
  }
}
