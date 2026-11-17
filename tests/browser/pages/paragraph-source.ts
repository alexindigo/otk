// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";

/** Source continuity probe shared by the native jump test and DOM controls. */
export async function captureParagraph(pane: Locator, index?: number) {
  return await pane.evaluate((p, selected) => {
    const bounds = p.getBoundingClientRect(),
      paragraphs = Array.from(p.querySelectorAll(".otk-text p"));
    const node = selected === undefined
      ? paragraphs.find((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= bounds.top && r.bottom <= bounds.bottom;
      })!
      : paragraphs[selected];
    const message = node.closest("[data-message]"),
      item = node.closest("[data-virtual-key]");
    const group = paragraphs.filter((p) =>
      p.closest("[data-message]") === message &&
      p.closest("[data-virtual-key]") === item
    );
    return {
      message: node.closest("[data-message]")!.getAttribute("data-message"),
      key: node.closest("[data-virtual-key]")!.getAttribute("data-virtual-key"),
      text: node.textContent,
      paragraph: group.indexOf(node),
      top: node.getBoundingClientRect().top - bounds.top,
    };
  }, index);
}
export async function paragraphTop(
  pane: Locator,
  source: Awaited<ReturnType<typeof captureParagraph>>,
) {
  return await pane.evaluate((p, source) => {
    const group = Array.from(p.querySelectorAll(".otk-text p")).filter((e) =>
      e.closest("[data-message]")?.getAttribute("data-message") ===
        source.message &&
      e.closest("[data-virtual-key]")?.getAttribute("data-virtual-key") ===
        source.key
    );
    const node = group[source.paragraph];
    return node && node.textContent === source.text
      ? node.getBoundingClientRect().top - p.getBoundingClientRect().top
      : -Infinity;
  }, source);
}
