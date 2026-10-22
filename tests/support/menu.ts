// SPDX-License-Identifier: LGPL-3.0-only
import type { Cdp } from "./cdp.ts";

/** Native visibility precedes the Popover toggle and Menu's owned focus work.
 * Join that lifecycle before measuring, dismissing, or opening another anchor.
 */
export async function menuReady(
  browser: Cdp,
  selector: string,
  owner = ".otk-context-menu",
): Promise<void> {
  await browser.poll(`(async()=>{
    const root=document.querySelector(${
    JSON.stringify(owner)
  }),menu=document.querySelector(${JSON.stringify(selector)});
    if(root?.dataset.open!=='true'||!menu?.contains(document.activeElement))return false;
    const panel=menu.closest('.otk-popover-panel'),surface=menu.closest('.otk-surface');let rect=surface.getBoundingClientRect();
    for(let frame=0;frame<2;frame++){
      await new Promise(requestAnimationFrame);
      const next=surface.getBoundingClientRect();
      if(next.x!==rect.x||next.y!==rect.y||next.width!==rect.width||next.height!==rect.height)return false;
      rect=next;
    }
    return root.dataset.open==='true'&&panel.matches(':popover-open')&&menu.contains(document.activeElement)&&rect.width>0&&rect.height>0&&menu.getBoundingClientRect().height>0;
  })()`);
}
