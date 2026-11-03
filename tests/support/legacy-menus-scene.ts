// SPDX-License-Identifier: LGPL-3.0-only
import { menusScenario } from "./menus-scenario.ts";
import { Cdp } from "./cdp.ts";
import { menuReady } from "./menu.ts";
import { assert, assertEquals } from "@std/assert";
import { resources } from "./resources.ts";
import type {
  Commands,
  ControlRequest,
  Profile,
  TestLease,
} from "./fixture-control.ts";
export const visualMenuRoot =
  ':popover-open [role="menu"][aria-label="Context menu"]';
/** Fixed visual states only; behavior and native events live in Playwright. */
export async function legacyMenusScene(
  profile: Profile = "contract-menus-inbox",
) {
  const owner = await menusScenario(profile);
  const lease = await owner.dispatch({
    v: 1,
    id: "begin",
    command: "beginTest",
    params: { identity: "fixed-visual-state" },
  }) as TestLease;
  const b = await Cdp.launch(owner.info.root);
  resources().evidence("menus visual browser exceptions", () => {
    assertEquals(
      b.errors,
      [],
      "Uncaught browser exception in a fixed theme state",
    );
  });
  const call = <M extends keyof Commands>(command: M, params: Commands[M]) =>
    owner.dispatch(
      { v: 1, id: crypto.randomUUID(), command, params } as ControlRequest,
    );
  return {
    b,
    lease,
    url: owner.info.url,
    root: owner.info.root,
    rpc: (method: string, params: import("./fixture-control.ts").Json) =>
      call("productRpc", { lease: lease.lease, method, params }),
    async close() {
      await b.close();
      await call("endTest", { lease: lease.lease });
      await call("stop", {});
    },
  };
}
export async function visualMenu(b: Cdp, selector: string, empty = false) {
  const point = await b.evaluate<{ x: number; y: number }>(
    `(()=>{const el=document.querySelector(${
      JSON.stringify(selector)
    });el.scrollIntoView({block:'nearest',behavior:'instant'});const r=el.getBoundingClientRect();
    if(${empty})for(const y of [r.bottom-12,r.y+r.height/2,r.y+12])for(let x=r.x+8;x<r.right-4;x+=16){const hit=document.elementFromPoint(x,y);if(hit&&el.contains(hit)&&!hit.closest('[data-message],[data-project],[data-session],input,textarea,button,a,img'))return {x,y};}
    return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await b.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "right",
      buttons: type === "mousePressed" ? 2 : 0,
      clickCount: 1,
    });
  }
  await menuReady(b, visualMenuRoot);
  await menuGeometry(b, visualMenuRoot);
}
export async function menuGeometry(b: Cdp, selector: string) {
  const g = await b.evaluate<
    { inside: boolean; rows: number[]; balanced: boolean }
  >(`(()=>{const menu=document.querySelector(${
    JSON.stringify(selector)
  }),panel=menu.closest('.otk-surface'),r=panel.getBoundingClientRect(),first=menu.parentElement.firstElementChild.getBoundingClientRect(),last=menu.parentElement.lastElementChild.getBoundingClientRect();return {inside:r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth+.5&&r.bottom<=innerHeight+.5,rows:[...menu.querySelectorAll('button')].map(el=>el.getBoundingClientRect().height),balanced:Math.abs((first.top-r.top)-(r.bottom-last.bottom))<.5}})()`);
  assert(g.inside, JSON.stringify(g));
  assertEquals(g.rows, g.rows.map(() => 28));
  assert(g.balanced, JSON.stringify(g));
}
export async function visualDismiss(b: Cdp) {
  await b.key("Escape");
  await b.poll(`!document.querySelector('${visualMenuRoot}')`);
}
