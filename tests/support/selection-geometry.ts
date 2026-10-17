// SPDX-License-Identifier: LGPL-3.0-only
import type { Cdp } from "./cdp.ts";

/** Measure the browser's actual pseudo-element box, not inferred CSS coordinates. */
export async function selectionGeometry(
  b: Pick<Cdp, "send" | "evaluate">,
  selector: string,
): Promise<SelectionGeometry[]> {
  const { root } = await b.send("DOM.getDocument") as {
    root: { nodeId: number };
  };
  const { nodeIds } = await b.send("DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector,
  }) as { nodeIds: number[] };
  const result: SelectionGeometry[] = [];
  for (const nodeId of nodeIds) {
    const { object } = await b.send("DOM.resolveNode", { nodeId }) as {
      object: { objectId: string };
    };
    const { result: observed } = await b.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function(){
        const r=this.getBoundingClientRect();if(!r.width)return null;
        const vertical=this.dataset.otkSelection==='vertical',p=getComputedStyle(this,vertical?'::before':'::after'),s=getComputedStyle(this),selected=this.classList.contains('is-selected');
        this.classList.toggle('is-selected');const other=this.getBoundingClientRect();this.classList.toggle('is-selected');
        return {orientation:this.dataset.otkSelection,selected,rect:r.toJSON(),fill:s.backgroundColor,paint:p.backgroundColor,shift:Math.max(Math.abs(r.width-other.width),Math.abs(r.height-other.height)),position:p.position,radius:p.borderRadius,ariaSelected:this.getAttribute('aria-selected'),ariaCurrent:this.getAttribute('aria-current'),ariaPressed:this.getAttribute('aria-pressed')};
      }`,
    }) as { result: { value: SelectionGeometry & { rect: DOMRect } | null } };
    await b.send("Runtime.releaseObject", { objectId: object.objectId });
    if (!observed.value) continue;
    const item = observed.value;
    const { node } = await b.send("DOM.describeNode", { nodeId }) as {
      node: {
        pseudoElements?: { backendNodeId: number; pseudoType: string }[];
      };
    };
    const pseudo = node.pseudoElements?.find((p) =>
      p.pseudoType === (item.orientation === "vertical" ? "before" : "after")
    );
    if (!pseudo) throw Error(`Missing permanent selection mark: ${selector}`);
    const { model } = await b.send("DOM.getBoxModel", {
      backendNodeId: pseudo.backendNodeId,
    }) as {
      model: { border: number[] };
    };
    const [x, y, right, , , bottom] = model.border, r = item.rect;
    result.push({
      ...item,
      w: right - x,
      h: bottom - y,
      centred: Math.abs((y + bottom) / 2 - r.y - r.height / 2),
      start: x - r.x,
      end: r.right - right,
      bottom: r.bottom - bottom,
    });
  }
  return result;
}
export interface SelectionGeometry {
  orientation: string;
  selected: boolean;
  w: number;
  h: number;
  centred: number;
  start: number;
  end: number;
  bottom: number;
  fill: string;
  paint: string;
  shift: number;
  position: string;
  radius: string;
  ariaSelected: string | null;
  ariaCurrent: string | null;
  ariaPressed: string | null;
}
