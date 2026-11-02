// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";

/** Chromium exposes the actual pseudo-element box only through its DOM domain. */
export async function selectionMarks(page: Page, selector: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector,
    });
    const result = [];
    for (const [index, nodeId] of nodeIds.entries()) {
      const measured = await page.locator(selector).nth(index).evaluate(
        (element) => {
          const r = element.getBoundingClientRect();
          element.classList.toggle("is-selected");
          const other = element.getBoundingClientRect();
          element.classList.toggle("is-selected");
          return {
            orientation: (element as HTMLElement).dataset.otkSelection,
            top: r.top,
            height: r.height,
            shift: Math.max(
              Math.abs(r.width - other.width),
              Math.abs(r.height - other.height),
            ),
          };
        },
      );
      const { node } = await cdp.send("DOM.describeNode", { nodeId });
      const pseudo = node.pseudoElements?.find((element) =>
        element.pseudoType ===
          (measured.orientation === "vertical" ? "before" : "after")
      );
      if (!pseudo) {
        throw new Error(`Missing permanent selection mark: ${selector}`);
      }
      const { model } = await cdp.send("DOM.getBoxModel", {
        backendNodeId: pseudo.backendNodeId,
      });
      const [left, top, right, , , bottom] = model.border;
      result.push({
        ...measured,
        width: right - left,
        markHeight: bottom - top,
        centred: Math.abs(
          (top + bottom) / 2 - measured.top - measured.height / 2,
        ),
      });
    }
    return result;
  } finally {
    await cdp.detach();
  }
}
