// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "node:path";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt, seed, tool } from "../../pages/attention.ts";

test.use({ profile: "contract-attention-native" });
test("attention.choice-frame-label-description-editor-and-selection", {
  tag: ["@attention", "@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await seed(state, "Choice frames");
  await openSession(state, page, session.id);
  await tool(state, "question", {
    questions: [{
      header: "Output",
      question: "Choose the output format",
      multiple: true,
      options: [
        { label: "Readable", description: "Keep the complete explanation" },
        { label: "Structured", description: "Return the exact source values" },
      ],
    }],
  });
  await prompt(page, "Ask about the output format");
  const dock = page.locator(".otk-question-dock");
  const frames = dock.locator(".otk-choice-frame");
  await expect(frames).toHaveCount(3);
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await frames.first().click();
    await expect(frames.first()).toHaveClass(/is-selected/);
    await expect(frames.first()).toHaveAttribute("aria-pressed", "true");
    await dock.getByRole("textbox", { name: "Custom answer" }).fill(
      "Preserve the source",
    );
    await expect(frames.last()).toHaveClass(/is-selected/);
    const geometry = await frames.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        const label = element.querySelector(".otk-choice-label")!
          .getBoundingClientRect();
        const detail = element.querySelector(".otk-choice-detail")!
          .getBoundingClientRect();
        const css = getComputedStyle(element);
        return {
          left: box.left,
          right: box.right,
          labelBottom: label.bottom,
          detailTop: detail.top,
          labelLeft: label.left,
          detailLeft: detail.left,
          border: css.borderTopWidth,
          radius: css.borderTopLeftRadius,
        };
      })
    );
    for (const box of geometry) {
      expect(Math.abs(box.left - geometry[0].left)).toBeLessThan(.5);
      expect(Math.abs(box.right - geometry[0].right)).toBeLessThan(.5);
      expect(box.detailTop).toBeGreaterThanOrEqual(box.labelBottom);
      expect(Math.abs(box.labelLeft - box.detailLeft)).toBeLessThan(.5);
      expect(box.border).toBe("1px");
      expect(box.radius).toBe(geometry[0].radius);
    }
    if (process.env.OTK_WP6_SCREENSHOTS) {
      await page.screenshot({
        path: join(
          process.env.OTK_WP6_SCREENSHOTS,
          `${process.env.OTK_WP6_STAMP}-wp6-question-${theme}.png`,
        ),
        fullPage: true,
      });
    }
    await frames.first().click();
    await expect(frames.first()).not.toHaveClass(/is-selected/);
    await expect(frames.first()).toHaveAttribute("aria-pressed", "false");
  }
});
