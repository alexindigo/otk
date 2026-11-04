// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
/** Read text fragments, not control height: subtitles and icons are separate. */
export async function labels(page: Page) {
  const result = await page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll(
        "button,a[href],input[type=button],input[type=submit],[role=button],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=treeitem],[role=checkbox],[role=radio],[role=switch],[role=link],[aria-expanded],summary,h1,h2,h3,h4,h5,h6,[role=heading],.otk-chip,.otk-pill",
      ),
    );
    return controls.filter((el) =>
      !el.matches(".otk-prose-heading,.otk-prose-link") &&
      el.checkVisibility({ visibilityProperty: true })
    ).map((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT),
        labels: { text: string; lines: number }[] = [];
      for (let node; (node = walker.nextNode());) {
        if (
          !node.textContent?.trim() ||
          !node.parentElement?.checkVisibility({ visibilityProperty: true })
        ) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects()).filter((r) =>
            r.width && r.height
          ),
          tops: number[] = [];
        for (const r of rects) {
          if (!tops.some((t) => Math.abs(t - r.top) < 1)) tops.push(r.top);
        }
        labels.push({ text: node.textContent.trim(), lines: tops.length });
      }
      return { control: el.className, labels };
    });
  });
  expect(result.length).toBeGreaterThan(0);
  expect(result.filter((c) => c.labels.some((l) => l.lines > 1))).toEqual([]);
}
