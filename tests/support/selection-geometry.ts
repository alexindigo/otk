// SPDX-License-Identifier: LGPL-3.0-only
/** Measure actual permanent paint boxes, including Tree's external mark track. */
export async function selectionGeometry(
  b: {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  },
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
    const { result: observed, exceptionDetails } = await b.send(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function(){
        const external=this.dataset.otkSelectionMark==='external',tree=external?this.closest('.otk-tree-node'):null,frame=tree?tree.querySelector(':scope > .otk-tree-heading'):this;
        const r=frame.getBoundingClientRect();if(!r.width)return null;
        const vertical=this.dataset.otkSelection==='vertical',mark=external?frame.querySelector('.otk-tree-selection-mark'):null;
        if(external&&!mark)throw Error('Missing permanent external selection mark');
        const p=mark?getComputedStyle(mark):getComputedStyle(this,vertical?'::before':'::after'),s=getComputedStyle(this),selected=this.classList.contains('is-selected');
        if(tree&&tree.classList.contains('has-selection')!==selected)throw Error('External mark selection differs from row');
        this.classList.toggle('is-selected');if(tree)tree.classList.toggle('has-selection');const other=frame.getBoundingClientRect();this.classList.toggle('is-selected');if(tree)tree.classList.toggle('has-selection');
        const rail=tree?.classList.contains('is-flat')?frame.querySelector(':scope > .otk-tree-rails'):null;
        return {orientation:this.dataset.otkSelection,external,railWidth:rail?.getBoundingClientRect().width??0,selected,rect:r.toJSON(),fill:s.backgroundColor,paint:p.backgroundColor,shift:Math.max(Math.abs(r.width-other.width),Math.abs(r.height-other.height)),position:p.position,radius:p.borderRadius,ariaSelected:this.getAttribute('aria-selected'),ariaCurrent:this.getAttribute('aria-current'),ariaPressed:this.getAttribute('aria-pressed')};
      }`,
      },
    ) as {
      result: { value: SelectionGeometry & { rect: DOMRect } | null };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    await b.send("Runtime.releaseObject", { objectId: object.objectId });
    if (exceptionDetails) {
      throw Error(
        exceptionDetails.exception?.description ?? exceptionDetails.text,
      );
    }
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
    let box: { nodeId: number } | { backendNodeId: number };
    if (item.external) {
      const { object } = await b.send("DOM.resolveNode", { nodeId }) as {
        object: { objectId: string };
      };
      const { result: marker } = await b.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration:
          "function(){return this.closest('.otk-tree-node').querySelector(':scope > .otk-tree-heading > .otk-tree-selection > .otk-tree-selection-mark')}",
      }) as { result: { objectId: string } };
      const { nodeId: markerID } = await b.send("DOM.requestNode", {
        objectId: marker.objectId,
      }) as { nodeId: number };
      await b.send("Runtime.releaseObject", { objectId: marker.objectId });
      await b.send("Runtime.releaseObject", { objectId: object.objectId });
      box = { nodeId: markerID };
    } else {
      if (!pseudo) throw Error(`Missing permanent selection mark: ${selector}`);
      box = { backendNodeId: pseudo.backendNodeId };
    }
    const { model } = await b.send("DOM.getBoxModel", {
      ...box,
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
  external?: boolean;
  railWidth: number;
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
