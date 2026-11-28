// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import {
  openImages,
  revealImage,
  samples,
  showReply,
} from "../../pages/inline-images.ts";

test.use({
  profile: "messages-private-home",
  viewport: { width: 1280, height: 800 },
});
for (
  const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
    "otk-light-stone",
    "stone",
  ]] as const
) {
  test(
    `visual.inline-image-${name}`,
    { tag: ["@visual", "@messages"] },
    async ({ isolatedState: state, page }, info) => {
      const f = await openImages(state, page, true);
      await state.product("prefs.set", { key: "theme", value: theme });
      await state.product("prefs.set", { key: "textSize", value: "100" });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await showReply(state, page, f.reply);
      const first = page.getByRole("button", {
        name: "Open image: Cabinet mockup",
      });
      const pictures = page.locator(".otk-inline-image img");
      await expect(pictures).toHaveCount(3);
      for (const image of samples) {
        const picture = await revealImage(page, image.alt);
        await expect.poll(() =>
          picture.evaluate((img: HTMLImageElement) => img.naturalWidth)
        ).toBeGreaterThan(0);
      }
      const capture = process.env.OTK_INLINE_IMAGE_SCREENSHOTS;
      const shot = async (view: string) => {
        if (capture) {
          await page.screenshot({ path: `${capture}/${view}-${name}.png` });
        }
        await info.attach(`${view}-${name}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      };
      await revealImage(page, samples[0].alt);
      await first.evaluate((button) =>
        button.scrollIntoView({ block: "start" })
      );
      for (const picture of await pictures.all()) {
        await expect(picture).toBeInViewport({ ratio: 0.95 });
      }
      const outline = (element: Element) =>
        getComputedStyle(element).outlineStyle;
      expect(await first.evaluate(outline)).toBe("none");
      await first.hover();
      expect(await first.evaluate(outline)).not.toBe("none");
      await shot("gallery");
      await first.focus();
      await expect(first).toBeFocused();
      await first.press("Space");
      const dialog = page.getByRole("dialog", { name: "a.png" });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("img")).toHaveJSProperty("naturalWidth", 320);
      await shot("zoom");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await showReply(state, page, f.reasons);
      const reasons = page.locator(".otk-inline-image-unavailable");
      await expect(reasons).toHaveCount(3);
      await reasons.first().scrollIntoViewIfNeeded();
      await reasons.last().scrollIntoViewIfNeeded();
      for (const box of await reasons.all()) {
        const result = await box.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            left: parseFloat(style.paddingLeft),
            right: parseFloat(style.paddingRight),
            lines: Array.from(
              element.querySelectorAll(
                ".otk-inline-image-alt, .otk-inline-image-reason",
              ),
              (span) => span.getClientRects().length,
            ),
          };
        });
        expect(result.left).toBeGreaterThan(0);
        expect(Math.abs(result.left - result.right)).toBeLessThanOrEqual(1);
        expect(result.lines).toEqual([1, 1]);
      }
      await shot("reasons");
    },
  );
}
