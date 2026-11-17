// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import {
  captureParagraph,
  paragraphTop,
} from "../../pages/paragraph-source.ts";

for (const duplicate of [false, true]) {
  test(
    `messages.source-continuity-measures-the-captured-nonfirst-paragraph: duplicate=${duplicate}`,
    { tag: ["@messages", "@contracts"] },
    async ({ page }) => {
      await page.setContent(
        `<section aria-label="Probe" style="height:400px;overflow:auto"><article data-message="same"><div data-virtual-key="source" class="otk-text"><p>First paragraph</p><p>${
          duplicate ? "Duplicate paragraph" : "Second paragraph"
        }</p><p>Duplicate paragraph</p></div><div data-virtual-key="sibling" class="otk-text"><p>Duplicate paragraph</p></div></article></section>`,
      );
      const pane = page.getByRole("region", { name: "Probe" }),
        paragraphs = pane.locator(".otk-text p");
      const source = await captureParagraph(pane, 2);
      const expected = await paragraphs.nth(2).evaluate((node) =>
        node.getBoundingClientRect().top -
        node.closest("section")!.getBoundingClientRect().top
      );
      expect(await paragraphTop(pane, source)).toBeCloseTo(expected, 6);
      await paragraphs.nth(0).evaluate((node) =>
        node.textContent = "A different predecessor"
      );
      expect(await paragraphTop(pane, source)).toBeCloseTo(expected, 6);
    },
  );
}
